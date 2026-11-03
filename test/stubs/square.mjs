export const SquareEnvironment = { Production: 'production' };
export class SquareClient {
  constructor() { throw new Error('Square client must not be constructed in tests'); }
}
