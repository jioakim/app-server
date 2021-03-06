//-------------------BEGIN Node/Express Setup--------------------
var fs = require('fs');
var express = require('express');
var app = express();
var cors = require('cors');
var bodyParser = require("body-parser");
var http = require('http');
var https = require('https');
// socket.io-stream for managein binary streams on client and server
var ss = require('socket.io-stream');
// shell for managing shell command lines, specifically for sox to convert audio to falc
var shell = require('shelljs');
// set the server as a client to send socket to the file to text server
const URL_TEXT_SERVER = 'http://localhost:9006';
// client side code for socket.io
var ioAsClient = require('socket.io-client');
//required key and cert for https, currently individual key from ioannis, there will be a browser warning for this

var serverPort = 9005;
var server = http.createServer(app);
//--------------END Node/Express Setup---------------------------

//--------------------BEGIN Firebase----------------------
var firebase = require("firebase-admin");

var serviceAccount = require("./key/benkyohr-e00dc-firebase-adminsdk-125v5-d1fdc86be0.json");

firebase.initializeApp({
  credential: firebase.credential.cert(serviceAccount),
  databaseURL: "https://benkyohr-e00dc.firebaseio.com"
});

// open database
var database = firebase.database();
//--------------------------END Firebase-----------------------------------

//--------------------BEGIN Socketio connection code--------------------------
//socket.io requirement and initialization
var ioAsServer = require('socket.io')(server);
// !!! Attention!!! ---> on the server we need to provide the nsp variable to connect to specific namespace of socketio, 
// as socketsio treats everything after the root domain of SERVER_URL on index.html as a namespace
//var nsp = ioAsServer.of('/benkyo-api-server');

// on server code we will use nsp instead of ioAsServer
ioAsServer.on('connection', function(socketAsServer){
  console.log('new connection');
  socketAsServer.on('bucket-stored', function(objData, aFn) {
    aFn(true);
    const downloadURL = objData.downloadURL;
    const filePrefix = objData.filePrefix;
    const fileNameWAV = filePrefix + '.wav';
    const filePathWAV = `./audio_files/${fileNameWAV}`;
    const fileNameFLAC = filePrefix + '.flac';
    const filePathFLAC = `./audio_files/${fileNameFLAC}`;
    const fileNameTXT = filePrefix + '.txt';
    const filePathTXT = `./transcribed_files/${fileNameTXT}`;

    const assignmentId = objData.assignmentId;
    const assessmentId = objData.assessmentId;
    const classroomId = objData.classroomId;
    const studentId = objData.user_cred.uid;
    
    var request = https.get(downloadURL, function(res){
      var writeStream = fs.createWriteStream(filePathWAV);
      var stream = res.pipe(writeStream);
      stream.on('finish', function(){
        console.log('wav file on server');
        shell.exec(`sox ${filePathWAV} --channels=1 --bits=16 --rate=16000 ${filePathFLAC} --norm`, {async:false});
        shell.rm(filePathWAV);
        //-----------app-server stream request to text-server--------------
        var socketioStreamToTextServer = ss.createStream();
        // the parameters of the connect function are required ton run under https
        // they also run under http, keeping them for reference
        var socketAsClient = ioAsClient.connect(URL_TEXT_SERVER, {secure: true, reconnect: true, rejectUnauthorized : false });
        // socketio-client requires that we listen to the connect event in order to initiate anything
        socketAsClient.on('connect', () => {
          // emit the flac file as stream along with the file name
          ss(socketAsClient).emit('appserver-stream-request', socketioStreamToTextServer, {fileNameFLAC}, (confirmation) =>{
            if (confirmation) {
              socketAsClient.disconnect(URL_TEXT_SERVER);
            }
          });
          fs.createReadStream(filePathFLAC).pipe(socketioStreamToTextServer);
          // listen to the event that fires when text comes back from text server and store the transcribed text
          socketAsClient.on('textserver-transcribebtext', (transcribedTextObj, aknFn)=>{
            const transcribebText = transcribedTextObj.transcribedText;
            const publicBucketURL = transcribedTextObj.publicBucketURL;
            firebase.database().ref(`assessments/${assessmentId}/Text`).once('value')
            .then(function(snapshot){
              if (snapshot.val()) {
                var originalText = snapshot.val().long;
                var scoreFromCompareWord = compareWordByWord(originalText, transcribebText);
                writeAssesssmentDataToFirebase(studentId, assignmentId, publicBucketURL, transcribebText, scoreFromCompareWord);
              }
            });
            // close the text-server text socket by calling the akn (aknowledge) function, see server code
            aknFn(true);
            // store the transcribed text to a file
            fs.writeFile(filePathTXT, transcribebText, (err) => {
              if (err) {
                console.log(err);
                return;
              }
              console.log('file ' + fileNameTXT + ' written to transcribed_files directory');
            });
          });
        });
      });
    });
  });
});

//-------------END Socketio -----------------------------------------------

//-----------------------BEGIN Write to firebase-------------------------------
function writeAssesssmentDataToFirebase (studentId, assignmentId, publicBucketURL, transcribebText, scoreFromCompareWord) {
  var varObject = {
    transcribedText: transcribebText,
    publicFlacURL: publicBucketURL,
    scoreFromCompareWord: scoreFromCompareWord,
    status: 'done'
  };
  firebase.database().ref(`student/${studentId}/assignment/${assignmentId}`).update(varObject);
}

//------------------------------END Write to firebase ---------------------------

app.use(cors());
app.use(bodyParser.json()); // <--- Here
app.use(bodyParser.urlencoded({extended: true}));
app.use(express.static(__dirname + '/public'));
app.use(express.static(__dirname + '/transcribed_files'));

/************************** Importing Files/Fucntions ******************/
var Users = require("./lib/user");
var Assessments = require("./lib/assessments");
var Classroom = require("./lib/classroom");
var Students = require("./lib/student");

/***************************** Routes ****************************/
app.use("/", express.static(__dirname));
app.get('/assessment/get', Assessments.getReleventAssessment)
app.get('/assessment/update', Assessments.updateReleventAssessment)
app.get('/assessment/getSortedData', Assessments.getAssessmentThroughSort)
app.get('/assessment/pushData', Assessments.pushReleventAssessment)
// app.get('/assessment/delete', Assessments.deleteReleventAssessment)


app.all('/teacher/getToken', Classroom.getGoogleClassOAuthToken);
app.all('/teacher/importClassroom', Classroom.getGoogleClassRoomData);

/***************************** Student Routes ****************************/
app.get('/student/sendData', Students.sendTranscribedAssessment);


server.listen(serverPort, function(){
  console.log('HTTP server up and running at %s port', serverPort);
});


// ------------COMPARISON FUNCTION--------------------------
var compareWordByWord = (original, read) => {
  original = original.split('.').join('');
  original = original.split(',').join('');
  original = original.split('-').join(' ');
  original = original.split('?').join('');
  original = original.split('\'').join('');
  original = original.split('’').join('');

  // console.log(original);

  read = read.split('.').join('');
  read = read.split(',').join('');
  read = read.split('-').join(' ');
  read = read.split('?').join('');
  read = read.split('\'').join('');
  read = read.split('’').join('');

  var original_split = original.split(' ');
  var read_split = read.split(' ');

  var originalObj = {};
  var readObj = {};
  var readCount = 0;

  for (var i = 0; i<original_split.length; i++) {
    originalObj[original_split[i].toLowerCase()] = false;
  }

  for (var j = 0; j<read_split.length; j++) {
    if (originalObj.hasOwnProperty(read_split[j].toLowerCase()) && !originalObj[read_split[j].toLowerCase()]){
      readCount ++;
      originalObj[read_split[j].toLowerCase()] = true;
    }
  }

  return readCount/Object.keys(originalObj).length;
}