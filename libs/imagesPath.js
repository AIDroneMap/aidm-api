// A task from a folder the API can read (the images path), under the
// folder set with --images_root (the images root). Each accepted file is
// linked into the task's staging folder: a hard link first, an absolute
// symbolic link when that fails. Nothing in the images path is ever
// opened for writing.

const fs = require('fs');
const path = require('path');
const async = require('async');
const config = require('../config');

// The image and video extensions of engine 0.2.0 (modules/context.py).
// Test mode has no engine to ask, so the lists live here and must follow
// the engine's when they change.
const EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp', '.raw', '.dng', '.nef', '.jxl',
    '.mp4', '.mov', '.lrv', '.ts'
]);

const accepted = name => EXTENSIONS.has(path.extname(name).toLowerCase());

const fail = message => new Error(message);

// fs.realpath throws instead of calling back on some input, such as a NUL byte
const realpath = (p, cb) => {
    try {
        fs.realpath(p, cb);
    } catch (e) {
        cb(e);
    }
};

const reason = err => {
    if (err.code === 'ENOENT') return 'it does not exist';
    if (err.code === 'ENOTDIR') return 'it is not a folder';
    if (err.code === 'EACCES' || err.code === 'EPERM') return 'permission denied';
    return err.code || err.message;
};

// True when target is root or lies inside it, compared by path segments,
// so a root /photos does not hold /photos2.
const inside = (root, target) => {
    const rel = path.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

// Checks that need no file system. Returns an error message or null.
const precheck = body => {
    if (body.imagesPath === undefined || body.imagesPath === '') return null;
    if (!config.imagesRoot) return "imagesPath is not enabled on this node. Start the node with --images_root to enable it.";
    if (body.zipurl) return "imagesPath and zipurl cannot both be set.";
    if (typeof body.imagesPath !== 'string' || body.imagesPath.includes('\0')) return "Cannot read imagesPath: it is not a valid path.";
    return null;
};

// Resolves the images path through real paths and lists its accepted files.
// cb(err, [{name, source}]) where source is the real path of the file.
const resolve = (imagesPath, cb) => {
    realpath(config.imagesRoot, (err, root) => {
        if (err) return cb(fail(`Cannot read the images root: ${reason(err)}.`));

        const requested = path.resolve(imagesPath);
        realpath(requested, (err, folder) => {
            if (err){
                // Say why only for a path that names a place under the root,
                // so a client cannot probe for paths outside it
                if (inside(root, requested) || inside(path.resolve(config.imagesRoot), requested)){
                    return cb(fail(`Cannot read imagesPath: ${reason(err)}.`));
                }
                return cb(fail("imagesPath is outside the images root."));
            }
            if (!inside(root, folder)) return cb(fail("imagesPath is outside the images root."));

            fs.stat(folder, (err, stats) => {
                if (err) return cb(fail(`Cannot read imagesPath: ${reason(err)}.`));
                if (!stats.isDirectory()) return cb(fail("Cannot read imagesPath: it is not a folder."));

                fs.readdir(folder, (err, names) => {
                    if (err) return cb(fail(`Cannot read imagesPath: ${reason(err)}.`));

                    // Top level only. A symbolic link counts when it resolves
                    // to a regular file inside the root.
                    const files = [];
                    async.eachSeries(names.filter(accepted).sort(), (name, cb) => {
                        realpath(path.join(folder, name), (err, source) => {
                            if (err || !inside(root, source)) return cb();
                            fs.stat(source, (err, stats) => {
                                if (!err && stats.isFile()) files.push({ name, source });
                                cb();
                            });
                        });
                    }, () => {
                        if (files.length === 0) cb(fail("imagesPath holds no supported image or video file."));
                        else cb(null, files);
                    });
                });
            });
        });
    });
};

// A hard link first; on any failure, a symbolic link to the absolute source.
const link = (source, destination, cb) => {
    fs.link(source, destination, err => {
        if (!err) return cb();
        fs.symlink(source, destination, 'file', cb);
    });
};

module.exports = {
    EXTENSIONS,
    precheck,
    link,

    // Links the accepted files of body.imagesPath into dir, which must exist.
    // Does nothing without imagesPath. cb(err) with an error for the response.
    linkInto: (body, dir, cb) => {
        const error = precheck(body);
        if (error) return cb(fail(error));
        if (!body.imagesPath) return cb();

        resolve(body.imagesPath, (err, files) => {
            if (err) return cb(err);
            async.eachSeries(files, (file, cb) => {
                link(file.source, path.join(dir, file.name), err => {
                    if (!err) cb();
                    else if (err.code === 'EEXIST') cb(fail(`Cannot link ${file.name} into the task: a file with that name exists.`));
                    else cb(fail(`Cannot link ${file.name} into the task: ${reason(err)}.`));
                });
            }, cb);
        });
    },

    // Finds the entries of dir that are hard links to files of body.imagesPath:
    // same name, same device and same inode. A move across devices cannot
    // keep a hard link, so the move makes those links again from the source.
    // cb(null, Map name -> source).
    hardLinks: (body, dir, cb) => {
        const links = new Map();
        if (!config.imagesRoot || typeof body.imagesPath !== 'string' || !body.imagesPath) return cb(null, links);

        realpath(path.resolve(body.imagesPath), (err, folder) => {
            if (err) return cb(null, links);
            fs.readdir(dir, (err, names) => {
                if (err) return cb(null, links);
                async.eachSeries(names.filter(accepted), (name, cb) => {
                    fs.lstat(path.join(dir, name), (err, staged) => {
                        if (err || !staged.isFile() || staged.nlink < 2) return cb();
                        realpath(path.join(folder, name), (err, source) => {
                            if (err) return cb();
                            fs.stat(source, (err, original) => {
                                if (!err && original.dev === staged.dev && original.ino === staged.ino) links.set(name, source);
                                cb();
                            });
                        });
                    });
                }, () => cb(null, links));
            });
        });
    }
};
