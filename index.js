var Express = require('express');
var Handlebars = require('handlebars');
var bodyParser = require('body-parser');
var fs = require('fs');
var run = require('./run.js');
var platform = require('./platform.js');
var wifi = require('./wifi.js');
var wait = require('./wait.js');
const axios = require('axios');
const { ipAdress } = require('./platforms/default.js');
var io = "";
var fs = require('fs');
const { networkInterfaces } = require('os');



// The Edison device can't scan for wifi networks while in AP mode, so
// we've got to scan before we enter AP mode and save the results
var preliminaryScanResults;


startServer();
// Wait until we have a working wifi connection. Retry every 3 seconds up
// to 10 times. If we are connected, then start just start the next stage
// and exit. But if we never get a wifi connection, go into AP mode.
waitForWifi(5, 3000)
  .then(() => { console.log('in Success'); loadBoardy() }, () => { console.log('in failure'); startChromium('/welcome'); startAP() })
  .catch(console.log("in catch (rey mysterio tu coco)"));



function loadBoardy() {
  var tokenPath = './token.txt';
  try {
    if (fs.existsSync(tokenPath)) {
      fs.readFile(tokenPath, 'utf8', (err, data) => {
        if (err) {
          console.error(err)
          return
        }
        openDashboard(data)
      })
    } else {
      startChromium('/login')
    }
  } catch (err) {
    console.error(err)
  }

}

// Return a promise, then check every interval ms for a wifi connection.
// Resolve the promise when we're connected. Or, if we aren't connected
// after maxAttempts attempts, then reject the promise
function waitForWifi(maxAttempts, interval) {
  return new Promise(function (resolve, reject) {
    var attempts = 0;
    check();

    function check() {
      attempts++;
      console.log('check', attempts);
      wifi.getStatus()
        .then(status => {
          console.log(status);
          if (status === 'COMPLETED') {
            console.log('Wifi connection found');
            resolve();
          }
          else {
            console.log('No wifi connection on attempt', attempts);
            retryOrGiveUp()
          }
        })
        .catch(err => {
          console.error('Error checking wifi on attempt', attempts, ':', err);
          retryOrGiveUp();
        });
    }

    function retryOrGiveUp() {
      if (attempts >= maxAttempts) {
        console.error('Giving up. No wifi available.');
        reject();
      }
      else {
        setTimeout(check, interval);
      }
    }
  });
}

function startAP() {
  console.log("startAP");

  // Scan for wifi networks now because we can't always scan once
  // the AP is being broadcast
  wifi.scan(10)   // retry up to 10 times
    .then(ssids => preliminaryScanResults = ssids) // remember the networks
    .then(() => wifi.startAP())                    // start AP mode
    .then(() => {
      console.log('No wifi found; entering AP mode')
    });
}

function startChromium(path) {
  console.log('on veut ouvrir: ' + path)
  run('sudo -u pi DISPLAY=:0 chromium-browser --kiosk http://localhost:80' + path)
}

function openDashboard(path) {
  console.log('on veut ouvrir: ' + path)
  run('sudo -u pi DISPLAY=:0 chromium-browser --kiosk ' + path)
}

function startServer(wifiStatus) {
  // Now start up the express server
  var qrcode = require('qrcode');
  var app = Express();
  const server = require('http').Server(app)
  app.use(Express.static(__dirname + '/public'));
  io = require('socket.io')(server)
  // When we get POSTs, handle the body like this
  app.use(bodyParser.urlencoded({ extended: false }));

  // Define the handler methods for the various URLs we handle
  app.get('/', handleWifiSetup);
  app.post('/connect', handleConnect);
  app.get('/login', handleLogin);
  app.get('/loginBoardy', handleLoginPage)
  app.post('/loginPage', loginBoardy)
  app.get('/welcome', handleWelcome);
  // And start listening for connections
  // XXX: note that we are HTTP only... is this a security issue?
  // XXX: for first-time this is on an open access point.

  io.on('connection', (socket) => {
      var addressIp = getIp()
      console.log("ip : " + addressIp)
      io.emit('ip', addressIp);
      qrcode.toDataURL("http://" + addressIp + "/loginBoardy", { width: 200 }, function (err, url) {
        io.emit('qrcode', url);
      });
    
  })

  server.listen(80, function () {
    console.log('Votre app est disponible sur localhost:80 !')
  })


  console.log('HTTP server listening on port 80');
}

function getIp() {
  var ip = "";
  while (ip == "") {
    console.log("On cherche une IP")
    const nets = networkInterfaces();
    const results = Object.create(null); // Or just '{}', an empty object

    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
        if (net.family === 'IPv4' && !net.internal) {
          if (!results[name]) {
            console.log(name)
            if(name == "wlan0"){
              console.log("On est dans le Wlan 0")
              if(net.address != null && net.address != ""){
                return net.address;
              }
              console.log("ip : "+ip)
            }
            results[name] = [];
          }
          results[name].push(net.address);
        }
      }
    }
  }
}

function handleWelcome(request, response) {
  response.sendfile('./templates/welcome.html');
}

function getTemplate(filename) {
  return Handlebars.compile(fs.readFileSync(filename, 'utf8'));
}

var wifiSetupTemplate = getTemplate('./templates/wifiSetup.hbs');
var connectTemplate = getTemplate('./templates/connect.hbs');

function handleLogin(request, response) {
  response.sendfile('./templates/login.html');
}


function handleLoginPage(request, response) {
  response.sendfile('./templates/loginPage.html')
}
function loginBoardy(request, response) {

  var email = request.body.email;
  var password = request.body.password;
  axios.post('https://boardy-app.com/api/auth', {
    email: email,
    password: password
  })
    .then(res => {
      console.log(`statusCode: ${res.statusCode}`)
      console.log(res.data.dashboard_url)
      if (res.data.token) {
        io.emit('redi', res.data.dashboard_url);
        fs.writeFile('token.txt', res.data.dashboard_url, function (err) {
          if (err) throw err;
          console.log('Saved!');
        });
        response.sendfile('./templates/connected.html');
      }
    })
    .catch(error => {
      console.error(error)
      response.sendfile('./templates/loginPage.html');
    })
}

// This function handles requests for the root URL '/'.
function handleWifiSetup(request, response) {
  wifi.scan().then(results => {
    // On Edison, scanning will fail since we're in AP mode at this point
    // So we'll use the preliminary scan instead
    if (results.length === 0) {
      results = preliminaryScanResults;
    }

    // XXX
    // To handle the case where the user entered a bad password and we are
    // not connected, we should show the networks we know about, and modify
    // the template to explain that if the user is seeing it, it means
    // that the network is down or password is bad. This allows the user
    // to re-enter a network.  Hopefully wpa_supplicant is smart enough
    // to do the right thing if there are two entries for the same ssid.
    // If not, we could modify wifi.defineNetwork() to overwrite rather than
    // just adding.

    response.send(wifiSetupTemplate({ networks: results }));
  });
}

function handleConnect(request, response) {
  var ssid = request.body.ssid.trim();
  var password = request.body.password.trim();

  response.send(connectTemplate({ ssid: ssid }));

  // Wait before switching networks to make sure the response gets through.
  // And also wait to be sure that the access point is fully down before
  // defining the new network. If I only wait two seconds here, it seems
  // like the Edison takes a really long time to bring up the new network
  // but a 5 second wait seems to work better.
  wait(2000)
    .then(() => wifi.stopAP())
    .then(() => wait(5000))
    .then(() => wifi.defineNetwork(ssid, password))
    .then(() => waitForWifi(5, 3000))
    .then(() => { console.log('in Success');startChromium('/login') }, () => { console.log('in failure'); startChromium('/welcome'); startAP() })
    .catch(() => {
      // XXX not sure how to handle an error here
      console.error("Failed to bring up wifi in handleConnect()");
    });
}

// Once wifi is up, we run the next stage command, if there is one, and exit.
function runNextStageAndExit() {
  if (platform.nextStageCommand) {
    run(platform.nextStageCommand)
      .then((out) => console.log('Next stage started:', out))
      .catch((err) => console.error('Error starting next stage:', err))
      .then(() => process.exit());
  }
  else {
    process.exit();
  }
}

// You can use this to give user feedback during the setup process.
function play(filename) {
  return run(platform.playAudio, { AUDIO: filename });
}
