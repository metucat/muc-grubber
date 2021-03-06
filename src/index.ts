#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const args = require('args');
const rimraf = require('rimraf');
const request = require('sync-request');

const versionedObjectTypes = ['datasets', 'interfaces', 'pipelines', 'publications', 'subscriptions', 'views'];

args.option('repo', 'Absolute path to local repository with project metadata', '');
args.option('metadataDir', 'Absolute path to local metadata dir', '');
args.option('targetDir', 'Relative path to directory where resulting js file should be put', '');
args.option('include', 'Relative path to file describing subset of metadata to be included in result (optional)', '');
args.option('includeOrg', 'Organization to be included in result (optional)', '');
args.option('pretty', 'Pretty-print output json (bigger file but human readable)', false);
args.option('json', 'Generate json files instead of metadata.js', false);
args.option('servicetoken', 'Get metadata from backend service (not git) using specified access token', '');
args.option('skipresources', 'Skip downloading of resources from views', false);
args.option('noEmbed', 'Skip downloading of resources from views', false);
args.option('skipEnum', 'Skip enums', false);

const flags = args.parse(process.argv);

if (flags.json && flags.repo == flags.targetDir) {
	throw 'Target directory should be different from source directory';
}
if (flags.includeOrg && flags.include) {
	throw 'Only one of includeOrg and include flags can be used';
}

let metadataPathFilter: any = false;

const metadata = {};

function cloneRepo() {
	try {
		childProcess.execSync(`git clone --local ${flags.repo} .mdtmp`);
		childProcess.execSync('cd .mdtmp && git checkout -b test && cd ..');
		return true;
	} catch (err) {
		return false;
	}
}

function deleteRepo() {
	try {
		// childProcess.execSync('rm -rf ./.mdtmp');
		rimraf('.mdtmp', (err) => {
			if (err) console.log(err);
		});
		return true;
	} catch (err) {
		console.log(err);
		return false;
	}
}

function getDirectories(srcpath) {
	return fs.readdirSync(srcpath).filter((file) => fs.statSync(path.join(srcpath, file)).isDirectory());
}

function getFiles(srcpath) {
	return fs.readdirSync(srcpath).filter((file) => !fs.statSync(path.join(srcpath, file)).isDirectory());
}

function getFullUri(obj) {
	if (!obj.object) return '';
	if (!obj.object.parent) {
		return `/organizations/${obj.identity.name}`;
	}

	// console.log('parent',obj.object.parent.name,'parts',parts,'res=',parentUri);

	if (!obj.object.type) {
		// console.log(obj.object);
	}

	return `${obj.object.parent.name}/${obj.object.type}s/${obj.identity.name}`;
}

function nonCSCompare(str1, str2) {
	if (!str1 && !str2) {
		// This is two empty strings case, we consider it equal
		return true;
	}
	if ((str1 && !(typeof str1 === 'string')) || (str2 && !(typeof str2 === 'string'))) {
		// We compare null or different types
		console.warn('nonCSCompare one of arguments is falsy', str1, str2);
		return false;
	}
	if (!str1 || !str2) {
		// We are compare null with string
		return false;
	}
	// Let's compare strings
	return str1.toLowerCase() === str2.toLowerCase();
}

function getVersionStatus(version) {
	// SEfalt status is draft
	let status = 'draft';
	if (!version || !version.object || !version.object.history || !version.object.history.completions) {
		// console.log("getVersionStatus:draft for ",JSON.stringify(version));
		if (version && version.object && version.object.history) {
			// console.log("getVersionStatus:draft for ",version.identity.name,JSON.stringify(version.object.history));
			return status;
		}
	}

	const { completions } = version.object.history;

	// Analize completion to have version status
	if (completions) {
		if (completions.reduce((p, c, i) => (nonCSCompare(c.status, 'Approved') ? true : p), false)) status = 'approved';
		else if (completions.reduce((p, c, i) => (nonCSCompare(c.status, 'Finalized') ? true : p), false)) status = 'finalized';
		// console.log("getVersionStatus:draft for ",completions,status);
	}
	return status;
}

function refToFileName(ref) {
	// const clearedPath = path.replace(/\/versions\/\d\.\d\.\d/g, '').replace(/:/g,"%");
	let version = '';
	if (ref.indexOf('/versions/') != -1) {
		const match = ref.match(/\/versions\/(\d+\.\d+\.\d+)/);
		console.log('match', match, ref);
		version = `-${match[1]}`;
	}
	let ret = ref.replace(/\/versions\/\d+\.\d+\.\d+/g, '').replace(/:/g, '%');
	ret = `${ret + version}.json`;
	console.log('refToFileName', ref, ret);
	return ret;
}

/**
 * Recursively goes through md project and imports JSON objects
 * @param {string} dir
 * @returns {{}}
 */
function scanDirectory(dir, metapath) {
	// console.log('Graber:DIR', dir, metapath, flags, metadataPathFilter);

	const dirs = getDirectories(dir).filter((dirName) => dirName.charAt(0) !== '.');
	const obj = {};
	const dir_parts = dir.split('/');
	const type = dir_parts[dir_parts.length - 1];

	const files = getFiles(dir).filter((fileName) => fileName.indexOf('.json') >= 1);

	// console.log('Graber:FILES', dirs, files);

	for (let j = 0; j < files.length; j++) {
		const f = files[j];
		const objName = f.replace(/.json/, '').replace(/\./g, '_').replace(/-/g, '[v]');

		if (objName.indexOf('[v]') > -1) continue;

		if (metadataPathFilter && metadataPathFilter.length > 0) {
			// console.log("Looking for ", (metapath + '/' + objName).toLowerCase(), " in ", metadataPathFilter);
			let found = false;
			for (let fi = 0; fi < metadataPathFilter.length; fi++) {
				if (`${metapath}/${objName}`.toLowerCase().indexOf(metadataPathFilter[fi].toLowerCase()) !== -1) {
					found = true;
					break;
				}
			}
			if (!found) continue;
		}

		//		console.log("metapath", metapath + '/' + objName);
		if (flags.servicetoken && metapath.indexOf('/organizations') !== -1) {
			console.log('will fetch ', `https://metaserviceprod.azurewebsites.net/api${metapath}/${objName}`);
			try {
				obj[objName.toLowerCase()] = JSON.parse(
					request('GET', `https://metaserviceprod.azurewebsites.net/api${metapath}/${objName}`, {
						headers: {
							Authorization: `Bearer ${flags.servicetoken}`,
						},
					}).getBody()
				);
				console.log('fetched ', objName.toLowerCase());
			} catch (e) {
				console.error(`could not fetch ${metapath}/${objName}`, e);
				obj[objName.toLowerCase()] = require(path.join(dir, f));
			}
		} else {
			obj[objName.toLowerCase()] = require(path.join(dir, f));
			const rawJson = require(path.join(dir, f));
			if (flags.skipEnum && rawJson.object.usage === 'Enum') {
				obj[objName.toLowerCase()] = {
					identity: {
						name: ''
					},
					object: {
						history: {}
					}
				};
			} else {
				obj[objName.toLowerCase()] = rawJson;
			}
		}
		const object = obj[objName.toLowerCase()];
		object._path = getFullUri(object);
		console.log('next metadata item: ', object._path);

		// object status
		if (versionedObjectTypes.indexOf(type) !== -1 || (object.object && object.object.history && object.object.history.completions)) {
			object._status = getVersionStatus(object);
			console.log('found versioned object, status=', object._status);
		}

		// paths of datasets in publication
		if (type == 'publications') {
			console.log('found publication', object.datasets, object.interfaces);
			if (object.datasets) {
				var appPath = object._path;
				appPath = appPath.substr(0, appPath.lastIndexOf('/'));
				appPath = appPath.substr(0, appPath.lastIndexOf('/'));
				object.datasets.map((dataset) => {
					dataset._path = `${appPath}/datasets/${dataset.identity.name}`;
				});
			}

			if (object.interfaces) {
				var appPath = object._path;
				appPath = appPath.substr(0, appPath.lastIndexOf('/'));
				appPath = appPath.substr(0, appPath.lastIndexOf('/'));
				object.interfaces.map((dataset) => {
					dataset._path = `${appPath}/interfaces/${dataset.identity.name}`;
				});
			}
		}

		if (type == 'subscriptions') {
			console.log('found subscription', object.datasets, object.interfaces);
			if (object.datasets) {
				var appPath = object.publication.identity.name;
				appPath = appPath.substr(0, appPath.lastIndexOf('/'));
				appPath = appPath.substr(0, appPath.lastIndexOf('/'));
				object.datasets.map((dataset) => {
					dataset._path = `${appPath}/datasets/${dataset.identity.name}`;
				});
			}
			if (object.interfaces) {
				var appPath = object.publication.identity.name;
				appPath = appPath.substr(0, appPath.lastIndexOf('/'));
				appPath = appPath.substr(0, appPath.lastIndexOf('/'));
				object.interfaces.map((dataset) => {
					dataset._path = `${appPath}/interfaces/${dataset.identity.name}`;
				});
			}
		}

		// Dataset fields, layout details are not embedded in Pipeline JSON

		if (type == 'pipelines') {
			if (flags.metadataDir) {
				console.log('flags.metadataDir');
				// var p = flags.metadataDir;
				var p = path.join(process.cwd(), flags.metadataDir);
			}
			if (flags.repo) {
				// path to temp repo
				console.log('flags.repo');
				var p = path.join(process.cwd(), '.mdtmp');
			}

			console.log('pipeline', object._path);
			console.log(object.activities);
			if (object.activities) {
				object.activities.map((activity) => {
					console.log('activity', activity);
					if (activity.inputs) {
						activity.inputs.map((input) => {
							if (input.inputMode == 'Dataset') {
								const ref = input.component.reference;
								const fileName = refToFileName(ref);
								console.log('Graner:Pipeline:Input', path.join(p, fileName), p, process.cwd());
								console.log('require');
								console.log(p);
								console.log(flags.metadataDir);
								const dataset = require(path.join(p, fileName));
								input._dataset = dataset;
							}
						});
					}
					if (activity.outputs) {
						activity.outputs.map((output) => {
							if (output.outputMode == 'Dataset') {
								const ref = output.component.reference;
								const fileName = refToFileName(ref);
								console.log('load output dataset from', path.join(p, fileName));
								const dataset = require(path.join(p, fileName));
								output._dataset = dataset;
							}
						});
					}
				});
			}
		}

		if (type == 'views' && object.definitions && !flags.skipresources) {
			object.definitions.map((def) => {
				if (def.elements) {
					def.elements.map((element) => {
						if (element.image) {
							const imageUrl = `${element.image.replace(/[^A-Za-z_0-9-]+/g, '_')}.png`;
							if (!fs.existsSync(path.join(flags.targetDir ? flags.targetDir : '', 'resources', imageUrl))) {
								console.log(`Found external resource: ${element.image} in object ${object._path}`);
								const imageData = request(
									'GET',
									element.image.replace('https://bias-metadata-service.difhub.com', 'https://apdax-metadata-service-dev.azurewebsites.net')
								).getBody();
								// fs.writeFileSync(path.join((flags.targetDir ? flags.targetDir : ''), object._path) + '__' + element.identity.name + '.png');
								// var imageUrl = element.image.replace('http://','').replace('https://','').replace('/','_').replace('\\','_').replace('?','_').replace('=','_');

								console.log('Downloaded, saving to ', imageUrl);
								fs.mkdirSync(path.join(flags.targetDir ? flags.targetDir : '', 'resources'), { recursive: true });
								fs.writeFileSync(path.join(flags.targetDir ? flags.targetDir : '', 'resources', imageUrl), imageData);
							}
						}
					});
				}
			});
		}

		if (flags.json) {
			const filePath = `${path.join(flags.targetDir ? flags.targetDir : '', object._path)}.json`;
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFile(filePath, flags.pretty !== false ? JSON.stringify(object, null, 2) : JSON.stringify(object), () => {});
		}

		obj[objName.toLowerCase()] = object;
	}

	if (dirs.length === 0) {
		return obj;
	}

	for (let i = 0; i < dirs.length; i++) {
		const d = dirs[i];

		obj[d.toLowerCase()] = scanDirectory(`${dir}/${d}`, metapath == '' ? `/organizations/${d}` : `${metapath}/${d}`);
	}

	// console.log(rootObj, typeof rootObj);

	return obj;
}

function findByPath(path) {
	if (!path) return null;

	// remove versions from path
	const clearedPath = path.replace(/\/versions\/\d+\.\d+\.\d+/g, '').replace(/:/g, '%');

	const splitPath = clearedPath.split('/').map((el) => el.toLowerCase());
	let res;

	for (const step of splitPath) {
		if (!res) res = metadata[step];
		else res = res[step];
	}

	return res;
}

// const metadata_apdax = require('./metadata_apdax.js').metadata;
const metadataApi = require('./metadataApi.js');

// console.log("metadata_apdax", metadata_apdax);
// console.log("metadataApi", metadataApi);

let metadataApiString = '';
//
let exportsString = 'export {metadata, findByPath';
for (const item in metadataApi) {
	// console.log("item", item, metadataApi[item]);
	if (typeof metadataApi[item] === 'function') metadataApiString += `var ${item} = ${metadataApi[item].toString()}; \n`;
	else metadataApiString += `var ${item} = ${JSON.stringify(metadataApi[item])}; \n`;
	exportsString += `, ${item}`;
}
exportsString += '}; ';

function writeMetadata(dir) {
	if (flags.include) {
		const include_str = fs.readFileSync(flags.include, 'utf-8');
		metadataPathFilter = include_str.split('\n').map((s) => s.trim());
	}
	if (flags.includeOrg) {
		metadataPathFilter = `/organizations/${flags.includeOrg}`;
	}

	console.log('Graber:SCAN', dir, flags);
	const obj = scanDirectory(dir, '');

	const outputFilename = path.join(flags.targetDir ? flags.targetDir : '', 'metadata.js');
	const outputJSONFilename = path.join(flags.targetDir ? flags.targetDir : '', 'metadata.json');
	const json = flags.pretty !== false ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);

	if (!flags.json) {
		if (!flags.noEmbed) {
			fs.writeFile(
				outputFilename,
				//			"var metadata_apdax = " + JSON.stringify(metadata_apdax, null, 2) + ";" +
				`var metadata = ${json}\n${findByPath.toString()}${metadataApiString}${exportsString}`, // "module.exports = {metadata: metadata, findByPath: findByPath};",
				() => {
					console.log('Metadata saved to', outputFilename);
				}
			);
		} else {
			fs.writeFileSync(outputJSONFilename, json);
			fs.writeFile(
				outputFilename,
				`const metadata = require('./metadata.json'); \n${findByPath.toString()}${metadataApiString}${exportsString}`, // "module.exports = {metadata: metadata, findByPath: findByPath};",
				() => {
					console.log('Metadata saved to', outputFilename);
				}
			);
		}
	}
}

if (flags.metadataDir) {
	console.log(flags.metadataDir);
	const dir = path.join(process.cwd(), `${flags.metadataDir}/organizations`);
	writeMetadata(dir);
}
if (flags.repo) {
	cloneRepo();
	// path to temp repo
	const dir = path.join(process.cwd(), '.mdtmp/organizations');
	writeMetadata(dir);
}

deleteRepo();
