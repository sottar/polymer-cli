/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import {transform as babelTransform, TransformOptions as BabelTransformOptions} from 'babel-core';
import * as cssSlam from 'css-slam';
import * as gulpif from 'gulp-if';
import {minify as htmlMinify, Options as HTMLMinifierOptions} from 'html-minifier';
import * as logging from 'plylog';
import {Transform} from 'stream';
import * as vinyl from 'vinyl';
import matcher = require('matcher');
import * as uuid from 'uuid/v1';

const babelPresetES2015 = require('babel-preset-es2015');
const minifyPreset = require('babel-preset-minify');
const babelPresetES2015NoModules =
    babelPresetES2015.buildPreset({}, {modules: false});
const externalHelpersPlugin = require('babel-plugin-external-helpers');
const babelObjectRestSpreadPlugin =
    require('babel-plugin-transform-object-rest-spread');
const babelPluginSyntaxDynamicImport =
    require('babel-plugin-syntax-dynamic-import');
const babelPluginSyntaxObjectRestSpread =
    require('babel-plugin-syntax-object-rest-spread');

// TODO(fks) 09-22-2016: Latest npm type declaration resolves to a non-module
// entity. Upgrade to proper JS import once compatible .d.ts file is released,
// or consider writing a custom declaration in the `custom_typings/` folder.
import File = require('vinyl');

const logger = logging.getLogger('cli.build.optimize-streams');

export type FileCB = (error?: any, file?: File) => void;
export type CSSOptimizeOptions = {
  stripWhitespace?: boolean;
};
export interface OptimizeOptions {
  html?: {
    minify?:
        boolean|{
          exclude?: string[]
        }
  };
  css?: {
    minify?:
        boolean|{
          exclude?: string[]
        }
  };
  js?: {
    minify?: boolean|{exclude?: string[]},
    compile?:
        boolean|{
          exclude?: string[]
        }
  };
}
;

/**
 * GenericOptimizeTransform is a generic optimization stream. It can be extended
 * to create a new kind of specific file-type optimizer, or it can be used
 * directly to create an ad-hoc optimization stream for different libraries.
 * If the transform library throws an exception when run, the file will pass
 * through unaffected.
 */
export class GenericOptimizeTransform extends Transform {
  optimizer: (content: string, options: any) => string;
  optimizerName: string;
  optimizerOptions: any;

  constructor(
      optimizerName: string,
      optimizer: (content: string, optimizerOptions: any) => string,
      optimizerOptions: any) {
    super({objectMode: true});
    this.optimizer = optimizer;
    this.optimizerName = optimizerName;
    this.optimizerOptions = optimizerOptions || {};
  }

  _transform(file: File, _encoding: string, callback: FileCB): void {
    // TODO(fks) 03-07-2017: This is a quick fix to make sure that
    // "webcomponentsjs" files aren't compiled down to ES5, because they contain
    // an important ES6 shim to make custom elements possible. Remove/refactor
    // when we have a better plan for excluding some files from optimization.
    if (!file.path || file.path.indexOf('webcomponentsjs/') >= 0 ||
        file.path.indexOf('webcomponentsjs\\') >= 0) {
      callback(null, file);
      return;
    }

    if (file.contents) {
      try {
        let contents = file.contents.toString();
        contents = this.optimizer(contents, this.optimizerOptions);
        file.contents = new Buffer(contents);
      } catch (error) {
        logger.warn(
            `${this.optimizerName}: Unable to optimize ${file.path}`,
            {err: error.message || error});
      }
    }
    callback(null, file);
  }
}

/**
 * JSBabelTransform uses babel to transpile Javascript, most often rewriting
 * newer ECMAScript features to only use language features available in major
 * browsers. If no options are given to the constructor, JSBabelTransform will
 * use
 * a babel's default "ES6 -> ES5" preset.
 */
class JSBabelTransform extends GenericOptimizeTransform {
  constructor(optimizerName: string, config: BabelTransformOptions) {
    const transform = (contents: string, options: BabelTransformOptions) => {
      const es5Code = babelTransform(contents, options).code!;
      return this._replaceTemplateObjectNames(es5Code);
    };
    super(optimizerName, transform, config);
  }

  /**
   * Modifies variables names of tagged template literals (`"_templateObject"`)
   * from a given string so that they're all unique.
   *
   * This is needed to workaround a potential naming collision when
   * individually transpiled scripts are bundled. See #950.
   */
  _replaceTemplateObjectNames(code: string): string {

    // Breakdown of regular expression to match "_templateObject" variables
    //
    // Pattern                | Meaning
    // -------------------------------------------------------------------
    // (                      | Group1
    // _templateObject        | Match "_templateObject"
    // \d*                    | Match 0 or more digits
    // \b                     | Match word boundary
    // )                      | End Group1
    const searchValueRegex = /(_templateObject\d*\b)/g;

    // The replacement pattern appends an underscore and UUID to the matches:
    //
    // Pattern                | Meaning
    // -------------------------------------------------------------------
    // $1                     | Insert matching Group1 (from above)
    // _                      | Insert "_"
    // ${uniqueId}            | Insert previously generated UUID
    const uniqueId = uuid().replace(/-/g, '');
    const replaceValue = `$1_${uniqueId}`;

    // Example output:
    // _templateObject  -> _templateObject_200817b1154811e887be8b38cea68555
    // _templateObject2 -> _templateObject2_5e44de8015d111e89b203116b5c54903

    return code.replace(searchValueRegex, replaceValue);
  }
}

/**
 * A convenient stream that wraps JSBabelTransform in our default "compile"
 * options.
 */
export class JSDefaultCompileTransform extends JSBabelTransform {
  constructor() {
    super('babel-compile', {
      presets: [babelPresetES2015NoModules],
      plugins: [
        externalHelpersPlugin,
        babelObjectRestSpreadPlugin,
        babelPluginSyntaxDynamicImport,
      ]
    });
  }
}

/**
 * A convenient stream that wraps JSBabelTransform in our default "minify"
 * options. Yes, it's strange to use babel for minification, but our minifier
 * babili is actually just a plugin for babel.
 * simplyComparisons plugin is disabled
 * (https://github.com/Polymer/polymer-cli/issues/689)
 */
export class JSDefaultMinifyTransform extends JSBabelTransform {
  constructor() {
    super('babel-minifiy', {
      presets: [minifyPreset(null, {simplifyComparisons: false})],
      plugins: [
        babelPluginSyntaxObjectRestSpread,
        babelPluginSyntaxDynamicImport,
      ]
    });
  }
}

/**
 * CSSMinifyTransform minifies CSS that pass through it (via css-slam).
 */
export class CSSMinifyTransform extends GenericOptimizeTransform {
  constructor(options: CSSOptimizeOptions) {
    super('css-slam', cssSlam.css, options);
  }

  _transform(file: File, encoding: string, callback: FileCB): void {
    // css-slam will only be run if the `stripWhitespace` option is true.
    // Because css-slam itself doesn't accept any options, we handle the
    // option here before transforming.
    if (this.optimizerOptions.stripWhitespace) {
      super._transform(file, encoding, callback);
    }
  }
}

/**
 * InlineCSSOptimizeTransform minifies inlined CSS (found in HTML files) that
 * passes through it (via css-slam).
 */
export class InlineCSSOptimizeTransform extends GenericOptimizeTransform {
  constructor(options: CSSOptimizeOptions) {
    super('css-slam', cssSlam.html, options);
  }

  _transform(file: File, encoding: string, callback: FileCB): void {
    // css-slam will only be run if the `stripWhitespace` option is true.
    // Because css-slam itself doesn't accept any options, we handle the
    // option here before transforming.
    if (this.optimizerOptions.stripWhitespace) {
      super._transform(file, encoding, callback);
    }
  }
}

/**
 * HTMLOptimizeTransform minifies HTML files that pass through it
 * (via html-minifier).
 */
export class HTMLOptimizeTransform extends GenericOptimizeTransform {
  constructor(options: HTMLMinifierOptions) {
    super('html-minify', htmlMinify, options);
  }
}

/**
 * Returns an array of optimization streams to use in your build, based on the
 * OptimizeOptions given.
 */
export function getOptimizeStreams(options?: OptimizeOptions):
    NodeJS.ReadWriteStream[] {
  options = options || {};
  const streams = [];

  // compile ES6 JavaScript using babel
  if (options.js && options.js.compile) {
    streams.push(gulpif(
        matchesExtAndNotExcluded('.js', options.js.compile),
        new JSDefaultCompileTransform()));
  }

  // minify code (minify should always be the last transform)
  if (options.html && options.html.minify) {
    streams.push(gulpif(
        matchesExtAndNotExcluded('.html', options.html.minify),
        new HTMLOptimizeTransform(
            {collapseWhitespace: true, removeComments: true})));
  }
  if (options.css && options.css.minify) {
    streams.push(gulpif(
        matchesExtAndNotExcluded('.css', options.css.minify),
        new CSSMinifyTransform({stripWhitespace: true})));
    // TODO(fks): Remove this InlineCSSOptimizeTransform stream once CSS
    // is properly being isolated by splitHtml() & rejoinHtml().
    streams.push(gulpif(
        matchesExtAndNotExcluded('.html', options.css.minify),
        new InlineCSSOptimizeTransform({stripWhitespace: true})));
  }
  if (options.js && options.js.minify) {
    streams.push(gulpif(
        matchesExtAndNotExcluded('.js', options.js.minify),
        new JSDefaultMinifyTransform()));
  }

  return streams;
};

function matchesExtAndNotExcluded(
    extension: string, option: boolean|{exclude?: string[]}) {
  const exclude = typeof option === 'object' && option.exclude || [];
  return (fs: vinyl) => {
    return !!fs.path && fs.relative.endsWith(extension) &&
        !exclude.some(
            (pattern: string) => matcher.isMatch(fs.relative, pattern));
  };
}
