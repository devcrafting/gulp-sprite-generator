var path        = require('path'),
    spritesmith = require('spritesmith'),
    File        = require('vinyl'),
    _           = require('lodash'),
    colors      = require('colors'),
    fs          = require('fs'),
    gutil       = require('gulp-util'),
    async       = require('async'),
    Q           = require('q'),
    through     = require('through2'),
    Readable    = require('stream').Readable,

    PLUGIN_NAME = "gulp-sprite-generator";

var log = function() {
    var args, sig;

    args = Array.prototype.slice.call(arguments);
    sig = '[' + colors.green(PLUGIN_NAME) + ']';
    args.unshift(sig);

    gutil.log.apply(gutil, args);
};

var getImages = (function() {
    var httpRegex, imageRegex, filePathRegex, pngRegex, retinaRegex;

    //imageRegex    = new RegExp('background-image:[\\s]?url\\(["\']?([\\w\\d\\s!:./\\-\\_@]*\\.[\\w?#]+)["\']?\\)[^;]*\\;(?:\\s*\\/\\*\\s*@meta\\s*(\\{.*\\})\\s*\\*\\/)?', 'ig');
    imageRegex    = new RegExp('background:[\\s]*url\\(["\']?([\\w\\d\\s!:./\\-\\_@]*\\.[\\w?#]+)["\']?\\)\\s*([^\\s\\;]*\\s*)([^\\s\\;]*\\s*)(no\\-repeat[^\\s\\;]*\\s*)([^\\;]*)\\;(?:\\s*\\/\\*\\s*@meta\\s*(\\{.*\\})\\s*\\*\\/)?(.*)$', 'igm');
    retinaRegex   = new RegExp('@(\\d)x\\.[a-z]{3,4}$', 'ig');
    httpRegex     = new RegExp('http[s]?', 'ig');
    pngRegex      = new RegExp('\\.png$', 'ig');
    filePathRegex = new RegExp('["\']?([\\w\\d\\s!:./\\-\\_@]*\\.[\\w?#]+)["\']?', 'ig');

    return function(file, content, options) {
        var reference, images,
            retina, filePath,
            url, image, meta, basename,
            makeRegexp;

        images = [];

        basename = path.basename(file.path);

        makeRegexp = (function() {
            var matchOperatorsRe = /[|\\/{}()[\]^$+*?.]/g;

            return function(str) {
                if (!str || !str.replace) {
                    return '';
                }
                return str.replace(matchOperatorsRe,  '\\$&');
            }
        })();
        
        while ((reference = imageRegex.exec(content)) != null) {
            matchedLine = reference[0];
            url   = reference[1];
            initialBackgroundX = reference[2];
            initialBackgroundY = reference[3];
            repeat = reference[4];
            unsupported = reference[5];
            meta  = reference[6];
            untilEndOfLine = reference[7];
            
            if (unsupported != ''){
                log(colors.cyan(basename) + ' > WARNING ' + url + ' has an unsupported attribute in background definition !', reference[0]);
            }
                                                            
            var initialBackgroundXParsed = initialBackgroundX.indexOf('left') >= 0 || initialBackgroundX === '' ? 0 : parseInt(initialBackgroundX);
            var initialBackgroundYParsed = initialBackgroundY.indexOf('top') >= 0 || initialBackgroundY === '' ? 0 : parseInt(initialBackgroundY);
            if (isNaN(initialBackgroundXParsed) || isNaN(initialBackgroundYParsed)) {
                log(colors.cyan(basename) + ' > ' + url + ' has been skipped as background is badly formatted for sprite generation (ensure background: [image url] [x-pos] [y-pos] [repeat], with nb px, left and top only for position) !', reference[0]);
                continue;
            }
                        
            image = {
                matchedLine: matchedLine,
                replacement: new RegExp('background:[\\s]*url\\(\\s?(["\']?)\\s?' + makeRegexp(url) + '\\s?\\1\\s?\\)\\s?' + makeRegexp(initialBackgroundX) + makeRegexp(initialBackgroundY) + makeRegexp(repeat) + makeRegexp(unsupported) + '\\;' + makeRegexp(meta) + makeRegexp(untilEndOfLine) + '$', 'igm'),
                url:         url,
                repeat: repeat,
                initialBackgroundX: initialBackgroundXParsed,
                initialBackgroundY: initialBackgroundYParsed,
                group:       [],
                isRetina:    false,
                retinaRatio: 1,
                meta:        {}
            };
                                    
            if (httpRegex.test(url)) {
                log(colors.cyan(basename) + ' > ' + url + ' has been skipped as it\'s an external resource!');
                continue;
            }

            if (!pngRegex.test(url) && options.excludeNotPng) {
                log(colors.cyan(basename) + ' > ' + url + ' has been skipped as it\'s not a PNG!');
                continue;
            }

            if (meta) {
                try {
                    meta = JSON.parse(meta);
                    meta.sprite && (image.meta = meta.sprite);
                } catch (err) {
                    log(colors.cyan(basename) + ' > ' + colors.white('Can not parse meta json for ' + url) + ': "' + colors.red(err) + '"');
                }
            }

            if (options.retina && (retina = retinaRegex.exec(url))) {
                image.isRetina = true;
                image.retinaRatio = retina[1];
            }

            filePath = filePathRegex.exec(url)[0].replace(/['"]/g, '');

            // if url to image is relative
            if(filePath.charAt(0) === "/") {
                filePath = path.resolve(options.baseUrl + filePath);
            } else {
                filePath = path.resolve(file.path.substring(0, file.path.lastIndexOf(path.sep)), filePath);
            }

            image.path = filePath;

            // reset lastIndex
            [httpRegex, pngRegex, retinaRegex, filePathRegex].forEach(function(regex) {
                regex.lastIndex = 0;
            });

            images.push(image);
        }

        // reset lastIndex
        imageRegex.lastIndex = 0;
        
        // remove nulls and duplicates
        images = _.chain(images)
            .filter()
            .unique(function(image) {
                return image.replacement;
            })
            .value();

        return Q(images)
            // apply user filters
            .then(function(images) {
                return Q.Promise(function(resolve, reject) {
                    async.reduce(
                        options.filter,
                        images,
                        function(images, filter, next) {
                            async.filter(
                                images,
                                function(image, ok) {
                                    Q(filter(image)).then(ok);
                                },
                                function(images) {
                                    next(null, images);
                                }
                            );
                        },
                        function(err, images) {
                            if (err) {
                                return reject(err);
                            }

                            resolve(images);
                        }
                    );
                });
            })
            // apply user group processors
            .then(function(images) {
                return Q.Promise(function(resolve, reject) {
                    async.reduce(
                        options.groupBy,
                        images,
                        function(images, groupBy, next) {
                            async.map(images, function(image, done) {
                                Q(groupBy(image))
                                    .then(function(group) {
                                        if (group) {
                                            image.group.push(group);
                                        }

                                        done(null, image);
                                    })
                                    .catch(done);
                            }, next);
                        },
                        function(err, images) {
                            if (err) {
                                return reject(err);
                            }

                            resolve(images);
                        }
                    );
                });
            });
    }
})();

var callSpriteSmithWith = (function() {
    var GROUP_DELIMITER = ".",
        GROUP_MASK = "*";

    // helper function to minimize user group names symbols collisions
    function mask(toggle) {
        var from, to;

        from = new RegExp("[" + (toggle ? GROUP_DELIMITER : GROUP_MASK) + "]", "gi");
        to = toggle ? GROUP_MASK : GROUP_DELIMITER;

        return function(value) {
            return value.replace(from, to);
        }
    }

    return function(images, options) {
        var all;

        all = _.chain(images)
            .groupBy(function(image) {
                var tmp;

                tmp = image.group.map(mask(true));
                tmp.unshift('_');

                return tmp.join(GROUP_DELIMITER);
            })
            .map(function(images, tmp) {
                var config, ratio;

                config = _.merge({}, options, {
                    src: _.unique(_.pluck(images, 'path'))
                });
                
                log(config.src);

                // enlarge padding, if its retina
                if (_.every(images, function(image) {return image.isRetina})) {
                    ratio = _.chain(images).flatten('retinaRatio').unique().value();
                    if (ratio.length == 1) {
                        config.padding = config.padding * ratio[0];
                    }
                }

                return Q.nfcall(spritesmith, config).then(function(result) {
                    tmp = tmp.split(GROUP_DELIMITER);
                    tmp.shift();

                    // append info about sprite group
                    result.group = tmp.map(mask(false));

                    return result;
                });
            })
            .value();


        return Q.all(all);
    }
})();

var updateReferencesIn = (function() {
    var template;

    template = _.template(
        'background: url("<%= spriteSheetPath %>") <%= repeat %>;\n    ' +
        'background-position: <%= -(isRetina ? (coordinates.x / retinaRatio) : coordinates.x) + initialBackgroundX %>px <%= -(isRetina ? (coordinates.y / retinaRatio) : coordinates.y) + initialBackgroundY %>px;\n    ' +
        'background-size: <%= isRetina ? (properties.width / retinaRatio) : properties.width %>px <%= isRetina ? (properties.height / retinaRatio) : properties.height %>px!important;'
    );

    return function(content) {
        return function(results) {
            results.forEach(function(images) {
                images.forEach(function(image) {
                    content = content.replace(image.replacement, template(image));
                });
            });

            return content;
        }
    }
})();

var exportSprites = (function() {
    function makeSpriteSheetPath(spriteSheetName, group) {
        var path;

        group || (group = []);

        if (group.length == 0) {
            return spriteSheetName;
        }

        path = spriteSheetName.split('.');
        Array.prototype.splice.apply(path, [path.length - 1, 0].concat(group));

        return path.join('.');
    }

    return function(stream, options) {
        return function(results) {
            results = results.map(function(result) {
                var sprite;

                result.path = makeSpriteSheetPath(options.spriteSheetName, result.group);

                sprite = new File({
                    path: result.path,
                    contents: new Buffer(result.image, 'binary')
                });

                stream.push(sprite);

                log('Spritesheet', result.path, 'has been created');


                return result;
            });

            // end stream
            //stream.push(null);

            return results;
        }
    }
})();

var exportStylesheet = function(stream, styleSheetName) {
    return function(content) {
        var stylesheet;

        stylesheet = new File({
            path: styleSheetName,
            contents: new Buffer(content)
        });

        stream.push(stylesheet);

        // end stream
        //stream.push(null);

        log('Stylesheet', styleSheetName, 'has been created');
    }
};

var mapSpritesProperties = function(images, options) {
    return function(results) {
        return results.map(function(result) {
            return _.flatten(
                _.map(result.coordinates, function(coordinates, path) {
                    return _.map(
                        _.where(images, {path: path}), 
                        function(image) {
                            return _.merge(image, {
                                coordinates: coordinates,
                                spriteSheetPath: options.spriteSheetPath ? options.spriteSheetPath + "/" + result.path : result.path,
                                properties: result.properties
                            })});
                }));
        });
    }
};

module.exports = function(options) { 'use strict';
    var stream, styleSheetStream, spriteSheetStream;

    options = _.merge({
        src:        [],
        engine:     "pngsmith", //auto
        excludeNotPng: true,
        algorithm:  "top-down",
        padding:    0,
        engineOpts: {},
        exportOpts: {

        },
        imgOpts: {
            timeout: 30000
        },

        baseUrl:         './',
        retina:          true,
        styleSheetName:  null,
        spriteSheetName: null,
        spriteSheetPath: null,
        filter:          [],
        groupBy:         []
    }, options || {});

    // check necessary properties
    ['spriteSheetName'].forEach(function(property) {
        if (!options[property]) {
            throw new gutil.PluginError(PLUGIN_NAME, '`' + property + '` is required');
        }
    });

    // prepare filters
    if (_.isFunction(options.filter)) {
        options.filter = [options.filter]
    }

    // prepare groupers
    if (_.isFunction(options.groupBy)) {
        options.groupBy = [options.groupBy]
    }

    // add meta skip filter
    options.filter.unshift(function(image) {
        image.meta.skip && log(image.matchedLine + ' has been skipped as it meta declares to skip');
        return !image.meta.skip;
    });

    // add not existing filter
    options.filter.push(function(image) {
        var deferred = Q.defer();

        fs.exists(image.path, function(exists) {
            !exists && log(image.path + ' has been skipped as it does not exist!');
            deferred.resolve(exists);
        });

        return deferred.promise;
    });

    // add retina grouper if needed
    if (options.retina) {
        options.groupBy.unshift(function(image) {
            if (image.isRetina) {
                return "@" + image.retinaRatio + "x";
            }

            return null;
        });
    }

    // create output streams
    function noop(){}
    styleSheetStream = new Readable({objectMode: true});
    spriteSheetStream = new Readable({objectMode: true});
    spriteSheetStream._read = styleSheetStream._read = noop;

    stream = through.obj(function(file, enc, done) {
        var content;

        if (file.isNull()) {
            this.push(file); // Do nothing if no contents
            return done();
        }

        if (file.isStream()) {
            this.emit('error', new gutil.PluginError(PLUGIN_NAME, 'Streams is not supported!'));
            return done();
        }

        if (file.isBuffer()) {
            content = file.contents.toString();

            var styleSheetName = options.styleSheetName || path.basename(file.path);

            getImages(file, content, options)
                .then(function(images) {
                    callSpriteSmithWith(images, options)
                        .then(exportSprites(spriteSheetStream, options))
                        .then(mapSpritesProperties(images, options))
                        .then(updateReferencesIn(content))
                        .then(exportStylesheet(styleSheetStream, styleSheetName))
                        .then(function() {
                            // pipe source file
                            stream.push(file);
                            done();
                        })
                        .catch(function(err) {
                            log('error: '+ err);
                            stream.emit('error', new gutil.PluginError(PLUGIN_NAME, err));
                            done();
                        });
                });


            return null;
        } else {
            log('error: file is not a buffer');
            this.emit('error', new gutil.PluginError(PLUGIN_NAME, 'Something went wrong!'));
            return done();
        }
    });

    stream.css = styleSheetStream;
    stream.img = spriteSheetStream;

    return stream;
};