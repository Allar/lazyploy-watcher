var os = require('os');
var dns = require('dns');
var fs = require('fs');
var path = require('path');
var unirest = require('unirest');
var mkdirp = require('mkdirp');

// User settings
var LazyployUrl = 'http://localhost/';
var Project = "GenericShooter";
var Platform = "WindowsServer";

// App Settings
var StorageDir = "./storage";
var BuildsDir = path.join(StorageDir, Project, Platform);
mkdirp(BuildsDir);

var CurrentBuild = -1;

var ServerStatus = {
    hostname: os.hostname(),
    localip: '0.0.0.0:0000',
    platform: 'WindowsNoEditor',
    build: 0,
    status: 'Dandy' 
};

dns.lookup(os.hostname(), function (err, addr, fam) {
   ServerStatus.localip = addr + ":0000";
});

function mainLoop() {
    heartbeat();
    
    getLatestRelevantBuild().then(function(build) {
        console.log(build);
        console.log('Latest: ' + getLatestLocalBuildId());
    }).catch(function (err) {
        console.error(err); 
    });
    
    loopTimer = setTimeout(mainLoop, 5000);
}

function createServerRecord() {
    unirest.post(LazyployUrl + 'api/servers')
    .send(ServerStatus)
    .end(function (response) {
       // Do nothing 
    });
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

function getLatestRelevantBuild() {
    return new Promise( function(resolve, reject) {
        unirest.get(LazyployUrl + 'api/builds')
        .query({ project: Project })
        .query('platforms[$like][0]=%'+ Platform + '%')
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


// File Management



// Kick off main loop
var loopTimer = setTimeout(mainLoop, 1000);