#!/usr/bin/env node
var program = require('commander');
var packageInfo = require('./package.json');
var Promise = require("bluebird");
var request = Promise.promisifyAll(require("request"));
var treeUtils = require('./utils/tree');
var EnhancedGenerator = require('./utils/Generator');
var deepClone = require('deep-clone');
var rimraf = require('rimraf');
var _ = require('lodash');
var API =  'https://www.snaptest.io/api';

/* Official SnapTest generators: */
var generators = {
  nightwatch: require("./generators/nightwatch/"),
  chromeless: require("./generators/chromeless/")
};

program
	.version(packageInfo.version)
    .option('-f, --folder <folder>', 'The test folder to generate')
    .option('-t, --token <token>', 'Your SnapTest auth token')
    .option('-o, --topDirName <name>', 'The name of the top level directory')
    .option('-v, --version', 'Get the version of snaptest')
    .option('-r, --framework <framework>', 'The choice of framework to generate')
    .option('-s, --style <style>', 'The style/flavor of the framework you to generate')
    .option('-i, --inputFile <inputFile>', 'Generate from a JSON test file')
    .option('-c, --pathToGen <pathToGen>', 'Path to custom generator')
    .parse(process.argv);

/* Set the active generator */

var generator;

if (program.framework) {
  generator = generators[program.framework];

  if (!generator) exitWithError("Official framework \'" + program.framework + "\' doesn't exist.");

} else if (program.pathToGen) {
  try {
    generator = require(process.cwd() + "/" + program.pathToGen);
    if (typeof generator.generate !== "function") exitWithError("Custom generator at path " + (process.cwd() + program.pathToGen) + " does not export a generate method.");
  } catch(e) {
    exitWithError("Custom generator error: " + e.toString() + e.stack);
  }
} else {
  exitWithError("Please specify an official generator with -r, or a custom generator path with -c (--help for more info).");
}

if (generator.styles && generator.styles.length > 1 && !program.style)
  exitWithError("Please select the framework style with -s.  Options:  " + generator.styles);

if (generator.styles && generator.styles.length > 1 && generator.styles.indexOf(program.style) === -1)
  exitWithError("Style " + program.style + " for framework "+ program.framework + " doesn't exist.");

if (typeof program.token === 'undefined' && typeof program.inputFile === "undefined")
  exitWithError('Please supply an auth token via -t <token> or supply a test JSON file with -i <inputFile>.');

if (typeof program.framework === 'undefined' && program.customGen === "undefined")
  exitWithError('no framework given.');

/* Load and prepare the test data for generation */

getTestData()
  .catch((error) => {
    exitWithError("Could not obtain the content for this user. reason: " + error);
  }).then((data) => {
    return prepData(data);
  }).then((testData) => {
    return removeOldTests(testData)
  }).then((testData) => {
    EnhancedGenerator(testData, generator)();
  }).catch((error) => {
    throw new Error(error);
  });

function exitWithError(error) {
  console.error(error);
  process.exit(1);
}

function getTestData() {
  // if token, get test JSON from the server.  otherwise, assume user is attempting to load a local JSON test file.
  return (program.token ?
      request.getAsync({
        url: API + '/load',
        headers: { 'apikey': program.token },
        "rejectUnauthorized": false,
      }).then((response) => {
        var rawData = JSON.parse(response.body);
        if (rawData.error) throw new Error(rawData.error);
        rawData.directory = rawData.directory.tree;
        return rawData;
      }) :
      new Promise((resolve, reject) => {
        try {
          return resolve(require(process.cwd() + "/" + program.inputFile));
        } catch(e) {
          return reject(e);
        }
      }));
}

function prepData(userData) {
  return new Promise((resolve, reject) => {

    var fullDirectory = deepClone(userData.directory);
    var directory;

    if (program.folder) {
      directory = deepClone(treeUtils.findNodeById(userData.directory, program.folder));
      if (!directory) {
        return reject("Couldn't find directory: " + program.folder + ".  Has it been deleted?");
      }
    } else {
      directory = deepClone(userData.directory);
    }

    // add some helper methods to the trees.
    treeUtils.enhanceTree(fullDirectory);
    treeUtils.enhanceTree(directory);

    var foldersToGen = [];
    var tests = [];
    var components = [];
    var topDirName = program.topDirName || "snaptests";

    treeUtils.walkThroughTreeNodes(directory, function(node, parent, idx) {

      var newFolderPath = (node.type !== "component" && node.type !== "test") ? node.module : "";
      var pathToRoot = "";

      treeUtils.walkUpParents(node, (parent) => {
        if (parent.root) return;
        newFolderPath = parent.module + "/" + newFolderPath;
        if (parent !== directory) pathToRoot = "../" + pathToRoot;
      });

      node.folderPath = newFolderPath.toLowerCase();

      if (node.children && idx !== 0) {  // case: node is folder
        foldersToGen.push(node.folderPath);
      }
      else if (node.type === "test") {
        // the node only has the test ID.  Find the test and add some node metadata to it.
        var test = _.find(userData.tests, {id: node.testId});
        if (test) {
          test.nodeId = node.id;
          test.folderPath = node.folderPath;
          test.pathToRoot = pathToRoot;
          tests.push(test);
        }
      }
      else if (node.type === "component") {
        // the node only has the component ID.  Find the component and add some node metadata to it.
        var component = _.find(userData.components, {id: node.testId});
        if (component) {
          component.nodeId = node.id;
          component.folderPath = node.folderPath;
          component.pathToRoot = pathToRoot;
          components.push(component);
        }
      }
    });

    return resolve({
      topDirName: topDirName,
      topDirPath: process.cwd() + "/" + topDirName,
      raw: {
        directory: fullDirectory,
        tests: userData.tests,
        components: userData.components
      },
      directory,
      components: components,
      tests: tests,
      folder: program.folder,
      style: program.style,
      framework: program.framework,
      folders: foldersToGen
    });

  });
}

function removeOldTests(userData) {
  return new Promise((resolve, reject) => {
    rimraf(userData.topDirPath, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(userData);
      }
    });
  });
}