export class OctetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OctetError';
  }
}
