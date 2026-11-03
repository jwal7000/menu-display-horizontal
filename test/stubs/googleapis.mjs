export const google = {
  auth: { GoogleAuth: class { getAccessToken() { throw new Error('GCS must not be used in tests'); } } },
};
