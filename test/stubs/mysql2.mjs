export default {
  createConnection() { throw new Error('MySQL must not be used in tests'); },
};
