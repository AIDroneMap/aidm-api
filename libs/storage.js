/*
NodeODX App and REST API to access ODX.
Copyright (C) 2026 NodeODX Contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.

Portions of this file are based on multer (https://github.com/expressjs/multer) (MIT licensed)
*/

const Busboy = require('busboy');
const fs = require('fs');
const path = require('path');

const active = new Map();

const removeFiles = (files, cb) => {
    let n = files.length;
    if (n === 0) return cb();
    files.forEach(f => fs.unlink(f, () => {
        if (--n === 0) cb();
    }));
};

const nextName = name => {
    const i = name.lastIndexOf('.');
    return i === -1 ? name + '_' : name.slice(0, i) + '_' + name.slice(i);
};

const parse = (req, res, next, opts) => {
    if (!/^multipart\//i.test(req.headers['content-type'] || '')) return next();
    if (!req.complete && req.socket && req.socket.destroyed) return next(new Error("Upload aborted"));

    let busboy;
    try{
        busboy = new Busboy({ headers: req.headers });
    }catch(e){
        return next(e);
    }

    const uploaded = [];
    req.body = Object.create(null);
    if (opts.field) req.files = uploaded;

    const writes = new Set();
    const waiters = [];
    let inflight = 0;
    let removed = false;
    let cleaning = false;
    let failErr = null;
    let readFinished = false;
    let ended = false;
    let isDone = false;
    let aborted = false;

    const cancel = cb => {
        abort(new Error("Upload canceled"));
        if (!aborted) return cb();
        waiters.push(cb);
        req.destroy();
        check();
    };

    const register = () => {
        if (!opts.field || req.id === undefined) return;
        if (!active.has(req.id)) active.set(req.id, new Set());
        active.get(req.id).add(cancel);
    };

    const unregister = () => {
        const set = active.get(req.id);
        if (!set) return;
        set.delete(cancel);
        if (set.size === 0) active.delete(req.id);
    };

    const onTimeout = () => {
        abort(new Error("Upload timed out"));
        req.destroy();
    };

    const socket = req.socket;
    const onSocketClose = () => abort(new Error("Upload aborted"));

    const unwatch = () => {
        if (socket) socket.removeListener('close', onSocketClose);
        if (!opts.idleTimeout) return;
        req.removeListener('timeout', onTimeout);
        req.setTimeout(0);
    };

    const done = err => {
        if (isDone) return;
        isDone = true;

        unregister();
        unwatch();
        req.unpipe(busboy);
        req.resume();
        busboy.removeAllListeners();
        busboy.on('error', () => {});

        if (ended) next(err);
        else req.once('end', () => next(err));
    };

    const check = () => {
        if (inflight !== 0) return;
        if (aborted){
            if (!removed) return;
            unregister();
            waiters.splice(0).forEach(cb => cb());
        }else if (failErr){
            if (cleaning) return;
            cleaning = true;
            removeFiles(uploaded, () => done(failErr));
        }else if (readFinished) done();
    };

    const fail = err => {
        if (!failErr) failErr = err;
        check();
    };

    const abort = err => {
        if (aborted || (isDone && !failErr)) return;
        aborted = true;

        unwatch();
        req.unpipe(busboy);
        busboy.removeAllListeners();
        busboy.on('error', () => {});

        for (const out of writes) out.destroy();
        removeFiles(uploaded, () => {
            removed = true;
            check();
        });

        if (!isDone){
            isDone = true;
            next(err);
        }
    };

    req.on('end', () => ended = true);

    if (socket) socket.once('close', onSocketClose);

    if (opts.field && opts.idleTimeout) req.setTimeout(opts.idleTimeout, onTimeout);

    busboy.on('field', (name, value, nameTruncated, valueTruncated) => {
        if (valueTruncated) return fail(new Error(`Field value too long: ${name}`));

        if (name in req.body) req.body[name] = [].concat(req.body[name], value);
        else req.body[name] = value;
    });

    busboy.on('file', (fieldname, fileStream, filename) => {
        if (!filename || failErr) return fileStream.resume();
        if (fieldname !== opts.field){
            fileStream.resume();
            return fail(new Error("Unexpected field"));
        }
        if (filename.indexOf('\0') !== -1){
            fileStream.resume();
            return fail(new Error("Invalid filename"));
        }

        const dir = opts.dir(req);
        let name = opts.rename(filename);
        let out = null;
        let broken = false;
        let attempts = 0;

        inflight++;

        const release = err => {
            if (err) failErr = failErr || err;
            inflight--;
            check();
        };

        fileStream.on('error', err => {
            broken = true;
            fail(err);
            if (out) out.destroy();
        });

        const create = () => {
            if (aborted || broken) return release();

            const finalPath = path.join(dir, name);
            fs.open(finalPath, 'wx', (err, fd) => {
                if (err && err.code === 'EEXIST' && ++attempts < 1000){
                    name = nextName(name);
                    return create();
                }
                if (err) return release(err);

                let finished = false;
                out = fs.createWriteStream(finalPath, { fd });
                writes.add(out);
                out.on('error', fail);
                out.on('close', () => {
                    writes.delete(out);
                    out = null;
                    if (finished) release();
                    else fs.unlink(finalPath, () => release());
                });

                if (aborted || broken) return out.destroy();

                fileStream.pipe(out);
                out.on('finish', () => {
                    if (aborted) return;
                    finished = true;
                    uploaded.push(finalPath);
                });
            });
        };

        fs.mkdir(dir, { recursive: true }, err => {
            if (err) return release(err);
            create();
        });
    });

    busboy.on('error', fail);
    busboy.on('finish', () => {
        readFinished = true;
        check();
    });

    register();
    req.pipe(busboy);
};

module.exports = {
    fields: () => (req, res, next) => parse(req, res, next, {}),

    files: (field, dir, rename, idleTimeout) => (req, res, next) => parse(req, res, next, { field, dir, rename, idleTimeout }),

    cancel: (id, cb) => {
        const set = active.get(id);
        if (!set) return cb();
        let n = set.size;
        set.forEach(cancel => cancel(() => {
            if (--n === 0) cb();
        }));
    }
};
