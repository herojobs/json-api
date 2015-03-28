import co from "co";
import polyfill from "babel/polyfill";

import Response from "../types/HTTP/Response";
import Document from "../types/Document";
import Collection from "../types/Collection";
import APIError from "../types/APIError";

import * as requestValidators from "../steps/http/validate-request";
import negotiateContentType from "../steps/http/negotiate-content-type";

import labelToIds from "../steps/pre-query/label-to-ids";
import parseRequestResources from "../steps/pre-query/parse-resources";
import applyTransform from "../steps/apply-transform";

import doGET from "../steps/do-query/do-get";
import doPOST from "../steps/do-query/do-post";
import doPATCH from "../steps/do-query/do-patch";
import doDELETE from "../steps/do-query/do-delete";

let supportedExt = ["bulk"];

class APIController {
  constructor(registry) {
    this.registry = registry;
  }

  /**
   * @param {Request} request The Request thic controller will use to generate
   *    the Response.
   * @param {Object} frameworkReq This should be the request object generated by
   *    the framework that you're using. But, really, it can be absolutely
   *    anything, as this controller won't use it for anything except passing it
   *    to user-provided functions that it calls (like transforms and id mappers).
   * @param {Object} frameworkRes Theoretically, the response objcet generated
   *     by your http framework but, like with frameworkReq, it can be anything.
   */
  handle(request, frameworkReq, frameworkRes) {
    let response = new Response();
    let registry = this.registry;

    // Kick off the chain for generating the response.
    return co(function*() {
      try {
        // throw if the body is supposed to be present but isn't (or vice-versa).
        yield requestValidators.checkBodyExistence(request);

        // If the request has a body, validate it and parse its resources.
        if(request.hasBody) {
          yield requestValidators.checkBodyIsValidJSONAPI(request.body);
          yield requestValidators.checkContentType(request, supportedExt);

          let parsedResources = yield parseRequestResources(
            request.body.data, request.aboutLinkObject
          );
          request.primary = applyTransform(
            parsedResources, "beforeSave", registry, frameworkReq, frameworkRes
          );
        }

        // Map label to idOrIds, if applicable.
        if(request.idOrIds && request.allowLabel) {
          let mappedLabel = yield labelToIds(
            request.type, request.idOrIds, registry, frameworkReq
          );

          // set the idOrIds on the request context
          request.idOrIds = mappedLabel;

          // if our new ids are null/undefined or an empty array, we can set
          // the primary resources too! (Note: one could argue that we should
          // 404 rather than return null when the label matches no ids.)
          let mappedIsEmptyArray = Array.isArray(mappedLabel) && !mappedLabel.length;

          if(mappedLabel === null || mappedLabel === undefined || mappedIsEmptyArray) {
            response.primary = (mappedLabel) ? new Collection() : null;
          }
        }

        // Actually fulfill the request!
        // If we've already populated the primary resources, which is possible
        // because the label may have mapped to no id(s), we don't need to query.
        if(typeof response.primary === "undefined") {
          switch(request.method) {
            case "get":
              yield doGET(request, response, registry);
              break;

            case "post":
              yield doPOST(request, response, registry);
              break;

            case "patch":
              yield doPATCH(request, response, registry);
              break;

            case "delete":
              yield doDELETE(request, response, registry);
          }
        }
      }

      // Add errors to the response converting them, if necessary, to
      // APIError instances first. Might be needed if, e.g., the error was
      // unexpected (and so uncaught and not transformed) in one of prior steps
      // or the user couldn't throw an APIError for compatibility with other code.
      catch (errors) {
        console.log(errors, errors.stack, errors[0].stack);
        errors = (Array.isArray(errors) ? errors : [errors]).map((it) => {
          if(it instanceof APIError) {
            return it;
          }
          else {
            const status = it.status || it.statusCode || 500;
            // if the user can't throw an APIError instance but wants to signal
            // that their specific error message should be used, let them do so.
            const message = it.isJSONAPIDisplayReady ? it.message :
              "An unknown error occurred while trying to process this request.";

            return new APIError(status, undefined, message);
          }
        });
        response.errors = response.errors.concat(errors);
      }

      // Negotiate the content type
      response.contentType = yield negotiateContentType(
        request.accepts, response.ext, supportedExt
      );

      // If we have errors, return here and don't bother with transforms.
      if(response.errors.length) {
        response.status = pickStatus(response.errors.map(
          (v) => Number(v.status)
        ));
        response.body = new Document(response.errors).get(true);
        return response;
      }

      // apply transforms pre-send
      response.primary = applyTransform(
        response.primary, "beforeRender", registry, frameworkReq, frameworkRes
      );

      response.included = applyTransform(
        response.included, "beforeRender", registry, frameworkReq, frameworkRes
      );

      if(response.status !== 204) {
        response.body = new Document(
          response.primary, response.included,
          undefined, registry.urlTemplates(), request.uri
        ).get(true);
      }

      return response;
    });
  }

  static responseFromExternalError(request, error) {
    let response = new Response();
    return negotiateContentType(request.accepts, [], supportedExt)
      .then((contentType) => {
        response.contentType = contentType;
        response.status = error.status || error.statusCode || 400;
        response.body  = (new Document([APIError.fromError(error)])).get(true);

        return response;
      }, () => {
        // even if we had an error, return the response.
        // it just won't have a content-type.
        return response;
      }
    );
  }
}

APIController.supportedExt = supportedExt;

export default APIController;

/**
 * Returns the status code that best represents a set of error statuses.
 */
function pickStatus(errStatuses) {
  return errStatuses[0];
}