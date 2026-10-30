/*
AIDM API, the REST task API of the AIDM photogrammetry engine.
Copyright (C) 2026 AIDM API Contributors

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
*/
"use strict";

// The API can listen on a Unix socket path next to its port. A second
// node:http server serves the same Express app there, so every route and the
// token check are the same on both.

const fs = require('fs');
const http = require('http');

// Returns an Error when the socket option cannot be used, null otherwise.
// The platform is an argument so a test can check the Windows refusal anywhere.
function checkOption(socketPath, platform){
    if (platform === 'win32'){
        return new Error('The socket option (--socket, or "socket" in the config file) is not supported on Windows. Use the port instead.');
    }
    if (typeof socketPath !== 'string' || socketPath.length === 0){
        return new Error('The socket option needs a path, for example --socket /run/task-api.sock');
    }
    return null;
}

// Nothing at the path is fine. A socket is left over from a stop that did not
// clean up, and is removed. Anything else, a symbolic link included, may be a
// user's file at a mistyped path: the start fails and the file stays.
function removeStale(socketPath, cb){
    fs.lstat(socketPath, (err, st) => {
        if (err){
            if (err.code === 'ENOENT') return cb();
            return cb(new Error(`Cannot check the socket path ${socketPath}: ${err.message}`));
        }
        if (!st.isSocket()){
            return cb(new Error(`Cannot listen on socket ${socketPath}: the path exists and is not a socket. Remove it or choose another path.`));
        }
        fs.unlink(socketPath, err => {
            if (err && err.code !== 'ENOENT') cb(new Error(`Cannot remove the stale socket ${socketPath}: ${err.message}`));
            else cb();
        });
    });
}

// Listens on the path and calls back with {server, close}. close() stops the
// server and removes the socket file, unless another listener has replaced it.
function listen(app, socketPath, cb){
    removeStale(socketPath, err => {
        if (err) return cb(err);

        const server = http.createServer(app);

        // The umask makes the socket 0600 from the moment it exists
        const umask = process.umask(0o177);
        let settled = false;
        const settle = err => {
            if (settled) return;
            settled = true;
            process.umask(umask);
            server.removeListener('error', settle);
            if (err) return cb(new Error(`Cannot listen on socket ${socketPath}: ${err.message}`));

            let ino;
            try{
                fs.chmodSync(socketPath, 0o600);
                ino = fs.lstatSync(socketPath).ino;
            }catch(e){
                server.close();
                return cb(new Error(`Cannot set the mode of socket ${socketPath}: ${e.message}`));
            }

            cb(null, {
                server,
                close: () => {
                    let ours = false;
                    try{
                        const st = fs.lstatSync(socketPath);
                        ours = st.isSocket() && st.ino === ino;
                    }catch(e){
                        // Already gone
                    }

                    // Closing the server unlinks the path, whatever it names
                    // by then. When the path no longer names this socket, the
                    // server stays open but cannot be reached, and stops
                    // holding the process; the callers exit right after.
                    if (!ours) return server.unref();
                    server.close();
                    try{
                        fs.unlinkSync(socketPath);
                    }catch(e){
                        // The close removed it already
                    }
                }
            });
        };
        server.once('error', settle);
        server.listen(socketPath, () => settle());
    });
}

module.exports = { checkOption, listen };
