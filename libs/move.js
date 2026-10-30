const fs = require('fs');
const path = require('path');

// Moves source to destination, with a copy when they are on different devices.
// links, optional, maps names inside a source directory to the files they are
// hard links of. A copy cannot keep a hard link, so on a copy those entries are
// made again with relink(source, entry destination, cb) instead of copied.
// Symbolic links are copied as links, never followed.
module.exports = function move(source, destination, links, relink, callback) {
    if (typeof links === 'function') {
        callback = links;
        links = null;
    }
    links = links || new Map();

    fs.rename(source, destination, err => {
        if (!err || err.code !== 'EXDEV') return callback(err);

        fs.stat(source, (err, stats) => {
            if (err) return callback(err);

            if (stats.isDirectory()) {
                fs.access(path.dirname(destination), err => {
                    if (err) return callback(err);

                    fs.rm(destination, { recursive: true, force: true }, err => {
                        if (err) return callback(err);

                        const skip = new Set([...links.keys()].map(name => path.join(source, name)));
                        fs.cp(source, destination, {
                            recursive: true,
                            force: false,
                            errorOnExist: true,
                            verbatimSymlinks: true,
                            filter: src => !skip.has(src)
                        }, err => {
                            if (err) return callback(err);
                            relinkAll([...links], destination, relink, err => {
                                if (err) return callback(err);
                                fs.rm(source, { recursive: true }, callback);
                            });
                        });
                    });
                });
            } else {
                fs.copyFile(source, destination, err => {
                    if (err) return callback(err);
                    fs.unlink(source, callback);
                });
            }
        });
    });
};

function relinkAll(entries, destination, relink, callback) {
    if (entries.length === 0) return callback();
    const [name, target] = entries[0];
    relink(target, path.join(destination, name), err => {
        if (err) return callback(err);
        relinkAll(entries.slice(1), destination, relink, callback);
    });
}
