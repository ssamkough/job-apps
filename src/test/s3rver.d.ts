declare module "s3rver" {
  export default class S3rver {
    constructor(options: {
      port?: number;
      address?: string;
      silent?: boolean;
      directory: string;
      configureBuckets?: Array<{ name: string; configs?: unknown[] }>;
    });
    run(): Promise<unknown>;
    close(): Promise<void>;
  }
}
