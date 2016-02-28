#!/bin/bash

sudo apt-get install curl git
curl --silent --location https://deb.nodesource.com/setup_5.x | sudo bash -
sudo apt-get install nodejs
sudo apt-get install -f npm

git clone http://github.com/Allar/lazyploy-watcher
cd lazyploy-watcher
npm install

nodejs index.js
