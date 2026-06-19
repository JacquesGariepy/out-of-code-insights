//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');

/**@type {(env: unknown, argv: { mode?: string }) => import('webpack').Configuration}*/
const buildConfig = (_env, argv) => ({
  // The active mode is driven by the CLI flag (`--mode development|production`);
  // webpack derives a matching `process.env.NODE_ENV` from it, so we must not
  // redefine that value ourselves (doing so triggers a DefinePlugin conflict).
  mode: argv.mode === 'development' ? 'development' : 'production',
  target: 'node', // Change to node for Claude Code SDK
  entry: './src/extension.ts', // Point d'entrée
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  devtool: 'source-map',
  externals: {
    vscode: 'commonjs vscode',
    '@octokit/rest': 'commonjs @octokit/rest',
    // Optional WebSocket performance dependencies
    'bufferutil': 'commonjs bufferutil',
    'utf-8-validate': 'commonjs utf-8-validate',
    // Don't externalize the Claude SDK, let webpack bundle it
    // '@anthropic-ai/claude-code': 'commonjs @anthropic-ai/claude-code'
  },
  resolve: {
    mainFields: ['module', 'main'],
    extensions: ['.ts', '.js'],
    alias: {
      // Ensure abort-controller is resolved properly
      'abort-controller': path.resolve(__dirname, 'node_modules/abort-controller')
    },
    fallback: {
      // VSCode extensions run in Node.js environment, but some packages might expect browser globals
      // We don't need browser polyfills since we're targeting node
    },
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          mangle: {
            reserved: ['Annotation.Add'], // Exemple de noms réservés
          },
        },
      }),
    ],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  plugins: [
    // Provide globals that might be missing in some environments
    new webpack.ProvidePlugin({
      'globalThis.AbortController': ['abort-controller', 'AbortController'],
      'global.AbortController': ['abort-controller', 'AbortController']
    }),
  ],
});

module.exports = buildConfig;
