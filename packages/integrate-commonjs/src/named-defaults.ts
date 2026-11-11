// A pattern whose default takes its binding's name keeps this file an ES module: as
// `exports` members the functions would lose their names.
export const [byDefault = function () {}, DefaultClass = class {}] = [];
