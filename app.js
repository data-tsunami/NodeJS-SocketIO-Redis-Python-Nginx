/*
 * Copyright (c) 2014 Horacio G. de Oro - hgdeoro@gmail.com
 * MIT License - See LICENSE.txt
 */

/*
 * Module dependencies.
 */

var _http = require('http');
var _io = require('socket.io');
var _redis = require('redis');
var _request = require('request');

// all environments
var UUIDCOOKIE_PREFIX = process.env.UUIDCOOKIE_PREFIX || 'cookie-';
var HTTP_PORT = process.env.PORT || 3000;
var SUBSCRIBE_BY_COOKIES_URL = process.env.SUBSCRIBE_BY_COOKIES_URL
    || 'http://localhost:3333/python/currentUserId/';

/*
 * Setup HTTP server and Socket.IO
 */

var server = _http.createServer();
var io = _io.listen(server, {
  'flash policy port' : -1
});

//
// Subscribe to the Redis to receive notifications, and re-send it to the client
// using Socket.IO.
//
// - socket: Socket.IO object to send notifications to the user
// - redisClient: Redis client, used to subscribe to PUB/SUB messages
// - userId: the currently logged in userId
//

function subscribeUserToNotifications(socket, redisClient, userId) {

  // var userId = redisReplyObj.userId;

  //
  // Hanlde Redis errors
  //
  redisClient.on("error", function(err) {
    // TODO: infor this error to client (using websocket)
    // TODO: close this websocket (so the client knows and reconnect)
    console.log("Error " + err);
  });

  //
  // Handle messages received from Redis
  //
  redisClient.on('message', function(pattern, data) {
    console.log('Suscriber received a message: ' + data);

    // Re-send message to the browser using Socket.IO
    socket.emit('notification', {
      message : data
    });
  });

  //
  // Subscribe to URL of notifications for the user
  //
  var url = '/app/user/' + userId + '/notifications';
  console.log('//------------------------------------------------------------');
  console.log('//');
  console.log("// Subscribing to Reids channel: " + url);
  console.log('//');
  console.log('// To send messages from the command line, run:');
  console.log('//');
  console.log('// $ redis-cli');
  console.log('// redis 127.0.0.1:6379> PUBLISH ' + url + ' "Hey" ');
  console.log('//');
  console.log('//------------------------------------------------------------');
  redisClient.subscribe(url);

  // Inform client the subscription was done
  socket.emit('internal', {
    type : 'success',
    code : 'SUBSCRIPTION_OK',
    message : 'Subscription to pub/sub ok.'
  });

}

//
// Subscribe to the Redis to receive notifications, and re-send it to the client
// using Socket.IO.
//
// This function is the callback passed to 'redisClient.get()'
//
// - socket: Socket.IO object to send notifications to the user
// - redisClient: Redis client, used to subscribe to PUB/SUB messages
// - redisKey: needed to delete the key from Redis after successful retrieval
// - redis_err: redis error, if get() failed this is !== null
// - redis_reply: the value associated to the requested KEY
//

function subscribeUserToNotificationsByUuidCookie(socket, redisClient,
    redisKey, redis_err, redis_reply) {

  console.log('redisClient.get() - redis_err: "' + redis_err
      + '" - redis_reply: "' + redis_reply + '"');

  // Check if response from Redis is valid
  if (redis_err !== null) {
    socket.emit('internal', {
      type : 'error',
      code : 'USER_ID_RETRIEVAL_RETURNED_ERROR',
      message : 'Error detected when trying to get user id.'
    });
    return;
  }

  // Check if response from Redis is valid
  if (redis_reply === null) {
    socket.emit('internal', {
      type : 'error',
      code : 'USERID_IS_NULL',
      message : 'Couldn\'t get userId.'
    });
    return;
  }

  // FIXME: should use something like 'get-and-delete' if exists
  // FIXME: is this realy neccesary? The key expires quickly, so,
  // maybe this isn't required
  console.log("Removing retrieved key from Redis");
  redisClient.del(redisKey);

  var redisReplyObj = JSON.parse(redis_reply);
  var userId = redisReplyObj.userId;

  subscribeUserToNotifications(socket, redisClient, userId);

}

//
// Attache '/io/user/notifications' to SocketIO
//
// When a client tryies to subscribe to notifications, it must send a
// uuidCookie. This uuidCookie is a random uuid generated by the original
// application.
//
// The original application must store a KEY/VALUE pair in Redis. The KEY is the
// uuidCookie, and the value is the userId. The userId is the key to make this
// work. The Node.JS app subscribe to Redis channel which contains the userId
// (here we use '/app/user/XXXXX/notifications', where XXXXX is the userId).
//
// When any message to the channel is published, the message is received by
// Node.JS and the message is sent to the client using Socket.IO.
//
// The uuidCookie must be put to Redis with something like:
//
// SET cookie-f156dbe0-1441-47b5-b74c-004cac13af2b 123456 EX 5 NX
//
// where '123456' is the userId, the uuidCookie will be saved for only 5
// seconds, and NX ensures that the uuidCookie DOESN'T exists. It's very
// important to check the SET command was successfull (if it returns error, this
// the generated uuidCookie already exists in Redis).
//
// An alternative to this mechanism whould be to get the http cookies received,
// and using that, try to get the userId.
//
// I consider the uuidCookies secure
//
//

io.of('/io/user/notifications').on(
    'connection',
    function(socket) {

      var address = socket.handshake.address;
      console.log('Connection from ' + address.address + ':' + address.port
          + ' with transport: ' + io.transports[socket.id].name);

      // ------------------------------------------------------------
      // subscribe-to-notifications, using uuidCookies
      // ------------------------------------------------------------

      socket.on('subscribe-to-notifications', function(data) {
        console.log('subscribe-to-notifications - data.uuid: "' + data.uuid);

        var redisKey = UUIDCOOKIE_PREFIX + data.uuid;
        var redisClient = _redis.createClient();
        redisClient.get(redisKey, function(err, reply) {
          subscribeUserToNotificationsByUuidCookie(socket, redisClient,
              redisKey, err, reply);
        });
      });

      // ------------------------------------------------------------
      // subscribe-to-notifications, using browser's cookies
      // ------------------------------------------------------------

      // console.log('Cookies: \'' + socket.handshake.headers.cookie +
      // '\'');
      // >>> Cookies: 'org.cups.sid=93f1b7c64591d501c97c47be3a6f2ddd;
      // >>>>>> __atuvc=17%7C4; csrftoken=U47JfEkPe57xiAOqV1tZGsZ5Birp5KQi;
      // >>>>>> sessionid=4ualeiw6ojrxcqx2uhil56o8go75zyoq'

      socket.on('subscribe-to-notifications-by-cookies', function(data) {
        console.log('subscribe-to-notifications-by-cookies');

        // If not configured the URL of the server, return
        // the error code 'SUBSCRIBE_BY_COOKIES_NOT_AVAILABLE'
        if (SUBSCRIBE_BY_COOKIES_URL === '') {
          console.log('SUBSCRIBE_BY_COOKIES_URL is EMPTY');
          socket.emit('internal', {
            type : 'error',
            code : 'SUBSCRIBE_BY_COOKIES_ERROR',
            message : 'Subscribe by cookies isn\'t available in the server.'
          });
          return;
        }

        console.log('SUBSCRIBE_BY_COOKIES - Sending request to '
            + SUBSCRIBE_BY_COOKIES_URL);

        // Send request to app. server
        _request.get(SUBSCRIBE_BY_COOKIES_URL, {
          headers : {
            cookie : socket.handshake.headers.cookie
          }
        }, function(er, res, body) {

          if (er) {
            console.log('SUBSCRIBE_BY_COOKIES - Server returned error: ' + er);
            socket.emit('internal', {
              type : 'error',
              code : 'SUBSCRIBE_BY_COOKIES_ERROR',
              message : 'Server returned error'
            });
          }

          if (res.statusCode !== 200) {
            console.log('SUBSCRIBE_BY_COOKIES - Server returned statusCode: '
                + res.statusCode);
            socket.emit('internal', {
              type : 'error',
              code : 'SUBSCRIBE_BY_COOKIES_ERROR',
              message : 'Server returned != 200'
            });
          }

          console.log('SUBSCRIBE_BY_COOKIES - Received body: ' + body);
          var userId = JSON.parse(body).userId;
          var redisClient = _redis.createClient();
          subscribeUserToNotifications(socket, redisClient, userId);

        });

      });

    });

//
// Configuration for production
// For further reading, see
// https://github.com/LearnBoost/Socket.IO/wiki/Configuring-Socket.IO
//

io.configure('production', function() {
  console.log("Loading settings for PRODUCTION...");
  io.enable('browser client minification'); // send minified client
  io.enable('browser client etag'); // apply etag caching logic based on version
  // number
  io.enable('browser client gzip'); // gzip the file
  io.set('log level', 1); // reduce logging

  // io.set('transports', [ 'websocket', 'flashsocket', 'htmlfile',
  // 'xhr-polling',
  // 'jsonp-polling' ]);
});

//
// Configuration for development
//

io.configure('development', function() {
  console.log("Loading settings for DEVELOPMENT. "
      + "Set 'NODE_ENV=production' to load for PRODUCTION");
});

//
// Start HTTP server
//

server.listen(HTTP_PORT, function() {
  console.log('Node.JS server listening on port ' + HTTP_PORT);
});
