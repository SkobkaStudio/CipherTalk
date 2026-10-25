const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'CipherTalk API',
      version: '1.0.0',
      description: 'CipherTalk Secure Messenger API'
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer'
        }
      }
    }
  },
  apis: ['./src/routes/*.js', './src/app.js']
};

module.exports = swaggerJsdoc(options);
