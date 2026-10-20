import path from 'node:path';

export default {
  dir: path.basename(__dirname),
  file: path.basename(__filename),
  required: require('./value.cts'),
};
