import pkg from '../package.json' with { type: 'json' };

/** The name of the product, as `GET /api/v1/meta` reports it. */
export const PRODUCT_NAME = 'OSFPM';

/** The name of this package, from its `package.json`. */
export const PACKAGE_NAME: string = pkg.name;

/** The version of this package, from its `package.json`. It is not the API version. */
export const PACKAGE_VERSION: string = pkg.version;
