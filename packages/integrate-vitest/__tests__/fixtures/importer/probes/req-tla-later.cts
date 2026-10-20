// Called after the TLA modules were loaded by import(), so they are in the cache.
module.exports = (id: string): string => {
  try {
    require(id);
    return 'loaded';
  } catch (e) {
    return (e as { code: string }).code;
  }
};
