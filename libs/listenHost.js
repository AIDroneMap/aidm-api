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

// The host option binds the port and the UDP progress receiver to one
// address. An empty host binds them to every interface.

// Returns an Error when the host option cannot be used, null otherwise.
// A flag given without a value reaches here as true.
function checkOption(host){
    if (typeof host !== 'string'){
        return new Error('The host option (--host, or "host" in the config file) needs an address, for example --host 127.0.0.1');
    }
    return null;
}

// "127.0.0.1:3000", or "[::1]:3000" for an IPv6 address
function hostPort(host, port){
    return (host.includes(':') ? `[${host}]` : host) + ':' + port;
}

module.exports = { checkOption, hostPort };
