import { ConfluenceClientError } from "@dust-tt/types";
import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  Next,
} from "@temporalio/worker";

export class ConfluenceCastKnownErrorsInterceptor
  implements ActivityInboundCallsInterceptor
{
  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundCallsInterceptor, "execute">
  ): Promise<unknown> {
    try {
      return await next(input);
    } catch (err: unknown) {
      if (
        err instanceof ConfluenceClientError &&
        err.type === "http_response_error" &&
        err.status === 500
      ) {
        throw {
          __is_dust_error: true,
          message: "Confluence Internal Error",
          type: "confluence_internal_error",
          error: err,
        };
      }
      if (
        err instanceof ConfluenceClientError &&
        err.type === "http_response_error" &&
        err.status === 502
      ) {
        throw {
          __is_dust_error: true,
          message: "502 Bad Gateway",
          type: "network_error",
          error: err,
        };
      }
      if (
        err instanceof ConfluenceClientError &&
        err.type === "http_response_error" &&
        err.status === 504
      ) {
        throw {
          __is_dust_error: true,
          message: "Request timed out",
          type: "network_timeout_error",
          error: err,
        };
      }
      throw err;
    }
  }
}
