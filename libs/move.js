const fs = require('fs');
const path = require('path');

module.exports = function move(source, destination, callback) {
    fs.rename(source, destination, err => {
        if (!err || err.code !== 'EXDEV') return callback(err);

        fs.stat(source, (err, stats) => {
            if (err) return callback(err);

            if (stats.isDirectory()) {
                fs.access(path.dirname(destination), err => {
                    if (err) return callback(err);

                    fs.rm(destination, { recursive: true, force: true }, err => {
                        if (err) return callback(err);

                        fs.cp(source, destination, {
                            recursive: true,
                            force: false,
                            errorOnExist: true,
                            verbatimSymlinks: true
                        }, err => {
                            if (err) return callback(err);
                            fs.rm(source, { recursive: true }, callback);
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
