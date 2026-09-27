const path = require('path')

// Toolchain follows the GlassTheme-proven modern line (ts-loader + TS5 + Angular 15 typings)
// with WebViewer's pug template pipeline added:
// - target: node       the plugin is loaded as CommonJS inside Tabby's renderer
// - externals          @angular/* / @ng-bootstrap/* / rxjs / tabby-* / fs / @electron/remote
//                      are provided by the Tabby host and must NOT be bundled
// - .pug templates go through apply-loader + pug-loader (component does
//   `template: require('./x.pug')`)
// - *.component.scss inlines as a CSS string for Angular's `styles: [...]`
//   (to-string-loader, NOT style-loader — the JIT style compiler needs a string)
// - js-yaml IS bundled (tabby-core does not export it)
module.exports = {
    mode: 'development',
    target: 'node',
    entry: './src/index.ts',
    devtool: 'source-map',
    context: __dirname,
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'index.js',
        pathinfo: true,
        libraryTarget: 'umd',
        devtoolModuleFilenameTemplate: 'webpack-tabby-better-configer:///[resource-path]',
    },
    resolve: {
        modules: ['.', 'src', 'node_modules'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /\.component\.scss$/,
                use: ['to-string-loader', 'css-loader', 'sass-loader'],
                exclude: /node_modules/,
            },
            { test: /\.pug$/, use: ['apply-loader', 'pug-loader'] },
        ],
    },
    externals: [
        'fs',
        // Resolved from the Tabby host at runtime (only typings used at compile time)
        '@electron/remote',
        /^rxjs/,
        /^@angular/,
        /^@ng-bootstrap/,
        /^tabby-/,
        // NOTE: @ngx-translate/core must NOT be listed here and must NOT be
        // imported — it is unreachable from a user plugin's require context,
        // and an unresolvable external kills this plugin AND every user
        // plugin loaded after it (silently). i18n goes through tabby-core's
        // LocaleService instead (see src/i18n.ts).
    ],
}
