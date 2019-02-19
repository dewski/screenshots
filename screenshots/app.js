const aws = require("aws-sdk");
const URL = require("url-parse");
const puppeteer = require("puppeteer");
const { extract, cleanup } = require("aws-puppeteer-lambda");

const s3 = new aws.S3();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function putObject(params) {
  return new Promise((resolve, reject) => {
    console.time(params.Key);

    s3.putObject(params, (err, data) => {
      console.timeEnd(params.Key);

      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
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
exports.lambdaHandler = async event => {
  const executionStarted = new Date();
  let url;
  try {
    url = new URL(event.queryStringParameters["url"], true);
  } catch (err) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "could not parse url",
        message: err.toString()
      })
    };
  }

  // Set min/max values
  const scaleFactor = parseInt(
    event.queryStringParameters["scale_factor"] || 2,
    10
  );
  const viewportWidth = parseInt(
    event.queryStringParameters["viewport_width"] || 1400,
    10
  );
  const viewportHeight = parseInt(
    event.queryStringParameters["viewport_height"] || 900,
    10
  );
  const wait = parseInt(event.queryStringParameters["wait"] || 1, 10);
  const fullPage = "full_page" in event.queryStringParameters;
  const path = event.queryStringParameters["path"];

  if (path === undefined || path === "") {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: "path not provided",
        message: "You must provide a path to store the image."
      })
    };
  }

  // Path to Chrome executable
  const executablePath = await extract();

  // Initialize a new browser instance with puppeteer to execute within Lambda.
  const browser = await puppeteer.launch({
    ignoreHTTPSErrors: true,
    args: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--no-sandbox"
    ],
    executablePath
  });

  // Run puppeteer script
  const page = await browser.newPage();

  try {
    console.debug(
      `Setting viewport to ${viewportWidth}x${viewportHeight} at ${scaleFactor}x...`
    );
    await page.setViewport({
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: scaleFactor
    });
  } catch (err) {
    await browser.close();
    await cleanup();

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "could not set viewport",
        message: err.toString()
      })
    };
  }

  try {
    console.debug(`Going to ${url.toString()}...`);
    await page.goto(url.toString(), { waitUntil: "load" });
    console.debug(`Successfully loaded ${url.toString()}...`);
  } catch (err) {
    await browser.close();
    await cleanup();

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "could not go to provided url",
        message: err.toString()
      })
    };
  }

  // Wait
  const duration = wait * 1000;
  console.debug(`Waiting ${duration} milliseconds...`);
  await sleep(duration);

  // TODO: Scrollpage

  let buffer;
  try {
    buffer = await page.screenshot({
      fullPage: fullPage,
      type: "png",
      encoding: "binary"
    });
    console.debug(`Generated ${fullPage} screenshot ${buffer.length} bytes...`);
  } catch (err) {
    await browser.close();
    await cleanup();

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "could not generate screenshot",
        message: err.toString()
      })
    };
  }

  await browser.close();

  // Cleanup the TMP folder after each execution otherwise Chromium's
  // garbage will cause the Lambda container to run out of space.
  await cleanup();

  const params = {
    Bucket: process.env.AWS_S3_BUCKET,
    CacheControl: "max-age",
    Key: path,
    Body: buffer,
    ACL: "public-read",
    ContentType: "image/png"
  };

  try {
    const response = await putObject(params);
    const executionFinished = new Date();

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        url: url.toString(),
        key: path,
        took: executionFinished - executionStarted
      })
    };
  } catch (err) {
    console.log("Error uploading image: ", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "could not store image",
        message: err.toString()
      })
    };
  }
};
