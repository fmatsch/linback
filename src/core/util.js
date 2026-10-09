'use strict';

/** Quote a string for safe use inside a POSIX shell command line. */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + u[i];
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ' h ' : '') + (h || m ? m + ' min ' : '') + s + ' s';
}

/** Returns a function that takes chunks and calls onLine for each complete line; .flush() emits the rest. */
function lineSplitter(onLine) {
  let buf = '';
  const push = (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  };
  push.flush = () => { if (buf) onLine(buf); buf = ''; };
  return push;
}

function timestamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = { shq, formatBytes, formatDuration, lineSplitter, timestamp };
