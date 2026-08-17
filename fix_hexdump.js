"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hexDump = hexDump;
// hexy dependency removed - inline CJS replacement for node-opcua-debug
// This avoids the ESM/CJS hexy conflict entirely.
function _hexyImpl(buf, opts) {
    opts = opts || {};
    var width = opts.width || 16;
    var lines = [];
    var b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    for (var i = 0; i < b.length; i += width) {
        var chunk = b.slice(i, i + width);
        var hex = Array.from(chunk).map(function(x) { return x.toString(16).padStart(2, '0'); }).join(' ');
        var asc = Array.from(chunk).map(function(x) { return (x >= 0x20 && x < 0x7f) ? String.fromCharCode(x) : '.'; }).join('');
        lines.push(i.toString(16).padStart(8, '0') + ': ' + hex.padEnd(width * 3 - 1) + '  ' + asc);
    }
    return lines.join('\n') + '\n';
}
var hexy = { hexy: _hexyImpl };

function hexDump(buffer, width, maxSize) {
    width = width || 32;
    maxSize = maxSize || 1024;
    if (!buffer) {
        return "<>";
    }
    if (buffer.length > maxSize) {
        return hexy.hexy(buffer.subarray(0, maxSize), { width: width, format: "twos" }) + "\n .... (" + buffer.length + ")";
    }
    return hexy.hexy(buffer, { width: width, format: "twos" });
}
//# sourceMappingURL=hexDump.js.map
