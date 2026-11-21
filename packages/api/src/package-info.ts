import pkg from '../package.json' with { type: 'json' };

/** The name of this package, from its `package.json`. */
export const PACKAGE_NAME: string = pkg.name;

/** The version of this package, from its `package.json`. It is not the API version. */
export const PACKAGE_VERSION: string = pkg.version;
