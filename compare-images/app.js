const aws = require('aws-sdk')
const path = require('path')
const os = require('os')
const fs = require('fs')
const BlinkDiff = require('blink-diff')

const s3 = new aws.S3()

function validateKey(value, key) {
  if (value === undefined || value === '') {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: `${key} missing`,
        message: `You must provide a valid path to ${key}`
      })
    }
  }
}

async function putObject(params) {
  return new Promise((resolve, reject) => {
    console.time(params.Key)
    s3.putObject(params, (err, data) => {
      console.time(params.Key)
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  })
}

async function getObject(key) {
  return new Promise((resolve, reject) => {
    console.debug(`Starting to fetch ${key}`)
    console.time(key)

    s3.getObject({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key
    }, (err, data) => {
      console.timeEnd(key)
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  })
}

async function headObject(key) {
  return new Promise((resolve, reject) => {
    s3.headObject({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key
    }, (err, data) => {
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  })
}

async function generateComposite(options) {
  const diff = new BlinkDiff(options)
  return new Promise((resolve, reject) => {
    diff.run((err, result) => {
      if (err) {
        reject(err)
      } else {
        resolve(result)
      }
    })
  })
}

/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {Object} event - API Gateway Lambda Proxy Input Format
 * @param {string} event.resource - Resource path.
 * @param {string} event.path - Path parameter.
 * @param {string} event.httpMethod - Incoming request's method name.
 * @param {Object} event.headers - Incoming request headers.
 * @param {Object} event.queryStringParameters - query string parameters.
 * @param {Object} event.pathParameters - path parameters.
 * @param {Object} event.stageVariables - Applicable stage variables.
 * @param {Object} event.requestContext - Request context, including authorizer-returned key-value pairs, requestId, sourceIp, etc.
 * @param {Object} event.body - A JSON string of the request payload.
 * @param {boolean} event.body.isBase64Encoded - A boolean flag to indicate if the applicable request payload is Base64-encode
 *
 * Context doc: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html
 * @param {Object} context
 * @param {string} context.logGroupName - Cloudwatch Log Group name
 * @param {string} context.logStreamName - Cloudwatch Log stream name.
 * @param {string} context.functionName - Lambda function name.
 * @param {string} context.memoryLimitInMB - Function memory.
 * @param {string} context.functionVersion - Function version identifier.
 * @param {function} context.getRemainingTimeInMillis - Time in milliseconds before function times out.
 * @param {string} context.awsRequestId - Lambda request ID.
 * @param {string} context.invokedFunctionArn - Function ARN.
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {Object} object - API Gateway Lambda Proxy Output Format
 * @returns {boolean} object.isBase64Encoded - A boolean flag to indicate if the applicable payload is Base64-encode (binary support)
 * @returns {string} object.statusCode - HTTP Status Code to be returned to the client
 * @returns {Object} object.headers - HTTP Headers to be returned
 * @returns {Object} object.body - JSON Payload to be returned
 *
 */
exports.lambdaHandler = async (event) => {
  const executionStarted = new Date()

  if(event.queryStringParameters === null) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "MISSING_KEY_ERROR",
        message: `Provided target_path '' does not exist`
      })
    }
  }

  let basePath = event.queryStringParameters['base_path']
  let targetPath = event.queryStringParameters['target_path']
  const destinationPath = event.queryStringParameters['destination_path']

  let validation = validateKey(basePath, 'base_path')
  if (validation !== undefined) {
    return validation
  }
  validation = validateKey(targetPath, 'target_path')
  if (validation !== undefined) {
    return validation
  }
  validation = validateKey(destinationPath, 'destination_path')
  if (validation !== undefined) {
    return validation
  }

  try {
    const metadata = headObject(destinationPath)
    console.log(metadata)
  }
  catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "EXISTING_KEY_ERROR",
        message: err.toString(),
      })
    }
  }

  const outputPath = path.join(os.tmpdir(), "comparison.png")
  let blinkOptions = {
    // Don't copy original images over
    copyImageAToOutput: false,
    copyImageBToOutput: false,

    // Don't show original images on left and right
    composition: false,

    // Don't show the shift of pixels
    hideShift: true,

    imageOutputPath: outputPath,
  }

  if (fs.existsSync(basePath)) {
    blinkOptions.imageAPath = basePath
  } else {
    try {
      const data = await getObject(basePath)
      blinkOptions.imageA = data.Body
    }
    catch (err) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "MISSING_KEY_ERROR",
          message: `Provided base_path '${basePath}' cannot be located`
        })
      }
    }
  }

  if (fs.existsSync(targetPath)) {
    blinkOptions.imageAPath = targetPath
  } else {
    try {
      const data = await getObject(targetPath)
      blinkOptions.imageB = data.Body
    }
    catch (err) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "MISSING_KEY_ERROR",
          message: `Provided target_path '${targetPath}' cannot be located`
        })
      }
    }
  }

  try {
    const composite = await generateComposite(blinkOptions)

    if (composite.differences === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "COMPARE_IMAGES_FAILED",
          message: "The two images are the same"
        })
      }
    } else if (fs.existsSync(outputPath)) {
      console.debug(`Found ${composite.differences} differences.`);

      if (!process.env.AWS_S3_BUCKET) {
        console.log(`No AWS_S3_BUCKET configured, comparison image saved at "${outputPath}".`);
        const executionFinished = new Date()

        return {
          statusCode: 200,
          body: JSON.stringify({
            differences: composite.differences,
            path: outputPath,
            took: executionFinished - executionStarted,
          })
        }
      }

      const fileData = fs.readFileSync(outputPath)
      const params = {
        Bucket: process.env.AWS_S3_BUCKET,
        Key: destinationPath,
        Body: fileData,
        ACL: 'public-read',
        ContentType: 'image/png',
      }

      try {
        const result = await putObject(params)
        const executionFinished = new Date()

        return {
          statusCode: 200,
          body: JSON.stringify({
            differences: composite.differences,
            path: destinationPath,
            took: executionFinished - executionStarted,
          })
        }
      }
      catch (err) {
        console.error("Error uploading image: ", err)

        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "IMAGE_UPLOAD_ERROR",
            message: error.toString(),
          })
        }
      }
    } else {
      console.debug("Could not generate comparison image.");

      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "COMPARE_IMAGES_ERROR",
          message: error.toString(),
        })
      }
    }
  }
  catch(err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "COMPARE_IMAGES_ERROR",
        message: err.toString(),
      })
    }
  }
  finally {
    if (fs.unlinkSync(outputPath)) {
      console.debug(`Successfully unlinked '${outputPath}'`)
    } else {
      console.debug(`Could not unlink '${outputPath}'`)
    }
  }
}