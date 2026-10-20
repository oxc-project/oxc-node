let code: string;
try { require('./tla.mts'); code = 'loaded'; } catch (e) { code = (e as { code: string }).code; }
module.exports = code;
