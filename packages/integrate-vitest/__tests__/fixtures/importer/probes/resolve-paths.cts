const path = require('path');

module.exports = {
  paths: require.resolve.paths('some-package'),
  builtin: require.resolve.paths('node:fs'),
  // Found under a folder of its own choosing, not next to this file.
  withPaths: require.resolve('fake-dep', { paths: [path.join(__dirname, '..', 'project')] }),
};
