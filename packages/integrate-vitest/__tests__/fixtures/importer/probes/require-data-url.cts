// `require.resolve` hands a `data:` URL back, as jiti does; `require` cannot load it.
exports.resolved = require.resolve("data:text/javascript,1");
try {
  require("data:text/javascript,1");
} catch (error) {
  exports.code = error.code;
  exports.stack = error.message.split("\n")[2];
}
