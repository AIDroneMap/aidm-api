const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const { unescape } = require('querystring');
const { pipeline, Writable } = require('stream');

function once(callback) {
    let called = false;
    return (...args) => {
        if (called) return;
        called = true;
        callback(...args);
    };
}

function consume(response, callback) {
    pipeline(response, new Writable({
        write(chunk, encoding, done) { done(); }
    }), callback);
}

function open(uri, method, headers, body, callback, redirects = 0, originalHost = null) {
    const done = once(callback);
    let response;
    try {
        const parsed = url.parse(uri);
        if (!parsed.hostname) throw new Error(`Invalid URI "${url.format(parsed)}"`);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Invalid protocol: ${parsed.protocol}`);
        }
        originalHost = originalHost || parsed.hostname;
        headers = { ...headers };
        if (parsed.auth && !headers.authorization) {
            const pieces = parsed.auth.split(':').map(value => unescape(value));
            const credentials = `${pieces[0]}:${pieces.slice(1).join(':')}`;
            headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
        }
        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.request({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.path || '/',
            method,
            headers
        }, incoming => {
            response = incoming;
            const location = incoming.headers.location;
            if (method !== 'POST' && incoming.statusCode >= 300 && incoming.statusCode < 400 && location) {
                consume(incoming, error => {
                    if (error) return done(error);
                    if (redirects >= 10) {
                        return done(new Error(`Exceeded maxRedirects. Probably stuck in a redirect loop ${parsed.href}`));
                    }
                    try {
                        const next = url.resolve(parsed.href, location);
                        const nextHost = url.parse(next).hostname;
                        if (incoming.statusCode !== 307 && nextHost !== originalHost) {
                            delete headers.authorization;
                        }
                        headers.referer = parsed.href;
                        open(next, method, headers, body, done, redirects + 1, originalHost);
                    } catch (error) {
                        done(error);
                    }
                });
            } else done(null, incoming);
        });
        request.on('error', error => {
            if (response) response.destroy(error);
            else done(error);
        });
        request.end(body);
    } catch (error) {
        done(error);
    }
}

function download(uri, filename, callback) {
    const done = once(callback);
    open(uri, 'HEAD', {}, null, (error, response) => {
        if (error) return done(error);
        consume(response, error => {
            if (error) return done(error);
            open(uri, 'GET', {}, null, (error, response) => {
                if (error) return done(error);
                pipeline(response, fs.createWriteStream(filename), error => {
                    if (!error && !response.complete) error = new Error('aborted');
                    done(error || undefined);
                });
            });
        });
    });
}

function postJson(uri, json, callback) {
    const done = once(callback);
    let body;
    try {
        body = JSON.stringify(json);
    } catch (error) {
        return done(error);
    }
    open(uri, 'POST', {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
    }, body, (error, response) => {
        if (error) return done(error);
        consume(response, error => done(error, response));
    });
}

module.exports = { download, postJson };
