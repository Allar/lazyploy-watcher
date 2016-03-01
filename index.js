var os = require('os');
var dns = require('dns');
var http = require('http');
var fs = require('fs-extra');
var Promise = require("bluebird");
var readdirAsync = Promise.promisify(fs.readdir);
var path = require('path');
var unirest = require('unirest');
var mkdirp = require('mkdirp');
var unzip = require('unzip');
var child_process = require('child_process');
var argv = require('minimist')(process.argv.slice(2));
var uuid = require('node-uuid');
var prompt = require('prompt');
var deasync = require('deasync');
var jsonfile = require('jsonfile');
var replace = require("replace");

// Prototypes
Array.prototype.firstElementIncluding = function(includeSearch) {
    for (i in this) {
        if (this[i].includes(includeSearch)) {
            return this[i];
        }
    }
    return null;
}
var bForceConfigPrompt = false;
if (argv.hasOwnProperty('config')) { bForceConfigPrompt = true }

// Try to load config settings, if it doesn't exist, prompt
// the user to provide these settings
var StoredSettings = require("./lazyploy-config.json");
if (StoredSettings == null || !StoredSettings.initialized || bForceConfigPrompt) {
    function promptForSettings() {
        var schema = {
            properties: {
                lazyploy: {
                    description: `URL of Lazyploy Server`,
                    default: StoredSettings.LazyployUrl
                },
                project: {
                    description: `Name of Project`,
                    default: StoredSettings.Project
                },
                platform: {
                    description: `Build Platform`,
                    default: StoredSettings.Platform
                },
                sessionowner: {
                    description: `Owner name of session for remote session connections`,
                    default: StoredSettings.SessionOwner
                },
                port: {
                    description: `Game Port`,
                    default: StoredSettings.Port
                },
                steamport: {
                    description: `Steam Query Port`,
                    default: StoredSettings.SteamPort
                }
            }
        };
        
        prompt.override = argv;
        prompt.start();
        
        var syncPromptGet = deasync(prompt.get);
        
        var result = syncPromptGet(schema);
        StoredSettings.LazyployUrl = result.lazyploy;
        StoredSettings.Project = result.project;
        StoredSettings.Platform = result.platform;
        StoredSettings.SessionOwner = result.sessionowner;
        StoredSettings.Port = result.port;
        StoredSettings.SteamPort = result.steamport;
        StoredSettings.initialized = true;
        
        jsonfile.writeFile('./lazyploy-config.json', StoredSettings, (err) => {
            if (err) {
                console.error(`Error writing new settings: ${err}`);
                throw(err);
            }
            process.exit(0);
        });
    }
    deasync(promptForSettings)();
}

// Override config args
// --config Runs config prompt
// --lazyploy=http://lazyploy.server/
// --project=ProjectName
// --platform=TargetPlatform
// --sessionowner=SessionOwner

// Default User settings
var LazyployUrl = StoredSettings.LazyployUrl;
var Project = StoredSettings.Project;
var Platform = StoredSettings.Platform;
var SessionOwner = StoredSettings.SessionOwner;

// Set any settings passed via command line
if (argv.hasOwnProperty('lazyploy')){ LazyployUrl = argv.lazyploy; }
if (argv.hasOwnProperty('project')){ Project = argv.project; }
if (argv.hasOwnProperty('platform')){ Platform = argv.platform; }
if (argv.hasOwnProperty('sessionowner')){ SessionOwner = argv.sessionowner; }

var PlatformName = Platform.includes('Windows') ? 'Win64' : 'Linux';
var SearchExt = Platform.includes('Windows') ? '.exe' : Project;
var EngineBinaryFolder = null;
var ProjectBinaryFolder = null;

// App Settings
var StorageDir = "./storage";
var TempDir = path.join(StorageDir, 'temp');
var BuildsDir = path.join(StorageDir, Project, Platform);
mkdirp.sync(TempDir);
mkdirp.sync(BuildsDir);

var LatestBuild = null;
var bBusy = false;

var ServerStatus = {
    hostname: os.hostname(),
    localip: '0.0.0.0:0000',
    project: Project,
    platform: Platform,
    build: -1,
    status: 'Dandy' 
};

// Process info
var RunningProcess = null;

// Get local ip address
// https://github.com/dominictarr/my-local-ip/blob/master/index.js

function getLocalIp() {
    var nics = os.networkInterfaces();
    for(var k in nics) {
        var inter = nics[k]
        for(var j in inter) {
            if(inter[j].family === 'IPv4' && !inter[j].internal) {
                return inter[j].address
            }
        }
    }
}
ServerStatus.localip = getLocalIp() + ':' + StoredSettings.Port;

ServerStatus.build = getLatestLocalBuildId();

function mainLoop() {
    updateCurrentStatus();
    heartbeat();
    
    if (!bBusy) {
        getCurrentBuildIsUpToDate().then( function(uptodate) {
            if (uptodate) {
                console.log("Current build (" + ServerStatus.build.toString() + ") up to date.");
                if (RunningProcess == null && ServerStatus.build != -1) {
                    bBusy = true;
                    console.log("Starting process.");
                    forceStatusUpdate('STARTING');
                    startRunningProcess().then(function () {
                        bBusy = false;  
                    }).catch(function(err) {
                        forceStatusUpdate('ERROR: PLEASE SEND HELP');
                    });
                }
            } else {
                bBusy = true;
                console.log("New build found. Starting update.")
                killRunningProcess().then(function() {
                    downloadLatestBuildFile().then(function() {
                        startRunningProcess().then(function () {
                            bBusy = false;  
                        }).catch(function(err) {
                            forceStatusUpdate('ERROR: PLEASE SEND HELP');
                        });
                    }).catch(function (err) {
                        forceStatusUpdate('ERROR: PLEASE SEND HELP');
                    });
                });
            }
        });
    }
    
    loopTimer = setTimeout(mainLoop, 5000);
}

function createServerRecord() {
    unirest.post(LazyployUrl + 'api/servers')
    .send(ServerStatus)
    .end(function (response) {
       // Do nothing 
    });
}

function updateCurrentStatus() {
    if (!bBusy) {
        if (RunningProcess == null) {
            ServerStatus.status = "Down";
        } else {
            ServerStatus.status = "Running";
        }
    }
}

function heartbeat() {
    unirest.patch(LazyployUrl + 'api/servers')
    .query({ localip: ServerStatus.localip})
    .send(ServerStatus)
    .end(function (response) {
        if (response.code == 200) {
            // No server object returned
            if (Array.isArray(response.body) && response.body.length <= 0) {
                createServerRecord();
                return;
            }
        }
    });
}

function forceStatusUpdate(newStatus) {
    ServerStatus.status = newStatus;
    heartbeat();    
}

// Process Management
function killRunningProcess() {
    return new Promise(function(resolve, reject) {
        if (RunningProcess == null) {
            resolve();
            return;
        }
        console.log("Shutting down running process.");
        forceStatusUpdate('Shutting Down');
        RunningProcess.kill();        
        var checkProcess = function() {
            if (RunningProcess == null) {
                resolve();
                return;
            }
            console.log("Waiting for process to die.");
            setTimeout(checkProcess, 1000); 
        };
        
        checkProcess();        
    });
}

function findExecFileInDir(Dir, SearchExt) {
    return new Promise(function(resolve, reject) {
        readdirAsync(Dir)
        .then((files) => {
            if (files.length > 0) {
                var execFile = files.firstElementIncluding(SearchExt);
                if (execFile != null) {
                    console.log(`Found execFile: ${execFile}`);
                    resolve(execFile);
                    return;
                }        
            }
            reject(`Failed to find exec file in ${Dir}`);
        }).catch((err) => {
           reject(`Failed to read directory ${Dir}`);
        });
    });
}

function findExecFile() {
    return new Promise(function(resolve, reject) {       
       
        // Linux exec is always ProjectName/Binaries/Linux/ProjectName
        if (Platform.includes('LinuxServer')) {
            console.log(`Checking for Linux Server binary in: ${ProjectBinaryFolder}`);
            findExecFileInDir(ProjectBinaryFolder, SearchExt + 'Server').then((execFile) => {
                resolve(path.join(ProjectBinaryFolder, execFile));
            }).catch( (err) => {
                console.error('Failed to find Linux server binary.');
                reject('Failed to find Linux server binary.');
            });
        } else if (Platform.includes('LinuxNoEditor')) {
            console.log(`Checking for Linux client binary in: ${ProjectBinaryFolder}`);
            findExecFileInDir(ProjectBinaryFolder, SearchExt).then((execFile) => {
                resolve(path.join(ProjectBinaryFolder, execFile));
            }).catch( (err) => {
                console.error('Failed to find Linux client binary.');
                reject('Failed to find Linux client binary.');
            });
        } else { // Windows
            // Check for C++ project binary first
            console.log(`Checking for C++ project binary in: ${ProjectBinaryFolder}`);
            findExecFileInDir(ProjectBinaryFolder, SearchExt).then((execFile) => {
                resolve(path.join(ProjectBinaryFolder, execFile));
            }).catch( (err) => {
                // Check for Blueprint project binary first
                console.log(`Checking for Blueprint project binary in: ${EngineBinaryFolder}`);
                findExecFileInDir(EngineBinaryFolder, SearchExt).then((execFile) => {
                    resolve(path.join(EngineBinaryFolder, execFile));
                }).catch( (err) => {
                    console.error('Failed to find either C++ or Blueprint project binary.');
                    reject('Failed to find either C++ or Blueprint project binary.');
                });    
            }); 
        }        
    });
}

function startRunningProcess() {
    return new Promise(function(resolve, reject) {
        if (RunningProcess != null) {
            resolve();
            return;
        }
        
        EngineBinaryFolder = path.join(BuildsDir, ServerStatus.build.toString(), 'Engine', 'Binaries', PlatformName);
        ProjectBinaryFolder = path.join(BuildsDir, ServerStatus.build.toString(), Project, 'Binaries', PlatformName);
        
        findExecFile().then( (execFile) => {
            var opts = {
                cwd: path.dirname(execFile),
                detached: false                    
            };
            var args = [];
            
            // If BP project, need to specifiy .uproject file
            // @TODO: Confirm this is valid for Linux C++ projects
            var bAddUprojectPath = execFile.includes('Engine') || Platform.includes('Linux');         
            if (bAddUprojectPath) {
                args.push(`../../../${Project}/${Project}.uproject`);
            }
            
            args.push('-stdout');
            args.push('-AllowStdOutLogVerbosity');
            args.push('-Messaging');
            args.push(`-InstanceId=${uuid.v4()}`);
            args.push(`-SessionId=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);
            args.push(`-SessionOwner=${SessionOwner}`);
            args.push(`-SessionName=Lazyploy Servers`);
           
            console.log(`Starting process: ${execFile}`);
            
            // Update port config
            var ConfigPath = path.join(BuildsDir, ServerStatus.build.toString(), Project, 'Config', 'DefaultEngine.ini');
            replace({
                regex: "\\bPort=\\d+",
                replacement: `Port=${StoredSettings.Port}`,
                paths: [ConfigPath],
                silent: true,
            });
            replace({
                regex: "\\bGameServerQueryPort=\\d+",
                replacement: `GameServerQueryPort=${StoredSettings.SteamPort}`,
                paths: [ConfigPath],
                silent: true,
            });
            
            // Spawn the process            
            if (Platform.includes('Linux')) {
                child_process.execSync(`chmod +x ${path.basename(execFile)}`, opts);
                RunningProcess = child_process.spawn('./' + path.basename(execFile), args, opts);
            } else {
                RunningProcess = child_process.spawn(path.basename(execFile), args, opts);
            } 
                       
            RunningProcess.on('error', (err) => {
                console.error(`Error starting process: ${err}`);
                reject(`Error starting process: ${err}`) ;
                return;
            });
            RunningProcess.stdout.on('data', (data) => {
                console.log(`Child process output: ${data}`); 
            });
            RunningProcess.stderr.on('data', (data) => {
                console.error(`Child process ERROR output: ${data}`); 
            });
            RunningProcess.on('close', (code) => {
                console.log("Process closed.");
                RunningProcess = null;
            });  
            
            resolve();     

        }).catch( (err) => {
            console.error('ERROR starting process: Can not find executable!');
            reject('ERROR starting process: Can not find executable!');
        });        
    });
}

// Build Management
function getLatestRelevantBuild() {
    return new Promise(function(resolve, reject) {
        unirest.get(LazyployUrl + 'api/builds')
        .query({ project: Project })
        .query('platforms[$like][0]=%'+ Platform + '%')
        .query('status[$like][0]=%Completed%')
        .query('$sort[id]=-1')
        .query('$limit=1')
        .end(function (response) {
            if (response == null || response == undefined) {
                reject('No response from server.');
                return;
            }
            if (Array.isArray(response.body) && response.body.length == 1) {
                resolve(response.body[0]);
                return;
            }
            reject('Bad response from server: ' + response);
        });
    });
}

function getLatestLocalBuildId() {
    var builds = fs.readdirSync(BuildsDir).filter(function(file) {
        return fs.statSync(path.join(BuildsDir, file)).isDirectory();
    });
    
    if (builds.length <= 0) {
        return -1;
    }
    
    return Math.max.apply(Math, builds);
}

function getCurrentBuildIsUpToDate() {
    return new Promise(function(resolve, reject) {
        getLatestRelevantBuild().then(function(build) {
            LatestBuild = build;
            resolve(LatestBuild.id == ServerStatus.build);
            return;
        }).catch(function (err) {
            if (ServerStatus.build == -1) {
                resolve(true);
                return;
            }
            reject(err);
        });
    });
}


// File Management

function downloadLatestBuildFile()
{
    return new Promise(function(resolve, reject) {
        forceStatusUpdate('Downloading Build ' + LatestBuild.id.toString());   
        var file = fs.createWriteStream(path.join(TempDir, LatestBuild.id + '.zip'));
        file.on('open', function(fd) {
            var url = LazyployUrl + 'api/builds/' + LatestBuild.id.toString() + '/download/' +  Platform + '.zip';
            console.log(url);
            http.get(url, function(res) {
                res.on('data', function(chunk) {
                    file.write(chunk);
                }).on('end', function() {
                    file.end();
                    var buildZipPath = path.join(BuildsDir, LatestBuild.id + '.zip');
                    fs.removeSync(buildZipPath);
                    fs.move(path.join(TempDir, LatestBuild.id + '.zip'), buildZipPath, { clobber: true }, function(err) {
                        if (err) {
                            console.error('Failed to move temp download file to build directory. Error:' + err);
                            reject(err);
                            return;
                        }
                        console.log("Downloaded latest build. Extracting...");
                        forceStatusUpdate('Extracting Build ' + LatestBuild.id.toString());  
                        var extractDir = path.join(BuildsDir, LatestBuild.id.toString());
                        fs.removeSync(extractDir);
                        mkdirp.sync(extractDir);
                        fs.createReadStream(buildZipPath)
                            .pipe(unzip.Parse())
                            .on('entry', (entry) => {
                                var filename = entry.path.replace(/\\/g, '/');
                                if (entry.type == 'Directory') {
                                    mkdirp.sync(path.join(extractDir, filename));
                                } else {
                                    filename = path.join(extractDir, filename);
                                    mkdirp.sync(path.dirname(filename));
                                    entry.pipe(fs.createWriteStream(filename));
                                }
                            }).on('close', function () {
                                console.log("Build extracted.");
                                forceStatusUpdate('Extracted Build' + LatestBuild.id.toString());  
                                ServerStatus.build = getLatestLocalBuildId();
                                resolve();  
                            }).on('error', function (readError) {
                                console.error('Failed reading in build zip. Error:' + readError);
                                reject(readError);
                            });
                    });
                });
            });
        });
    });
}


// Kick off main loop
var loopTimer = setTimeout(mainLoop, 1000);
