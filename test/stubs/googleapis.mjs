// GCS stays off-limits in tests unless a test opts in with globalThis.__FAKE_GCS_TOKEN
// (and stubs fetch itself), so nothing can reach real Google APIs by accident.
export const google = {
  auth: { GoogleAuth: class {
    getAccessToken() {
      if (globalThis.__FAKE_GCS_TOKEN) return globalThis.__FAKE_GCS_TOKEN;
      throw new Error('GCS must not be used in tests');
    }
  } },
};
