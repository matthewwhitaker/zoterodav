import { handle_head, handle_get, handle_put, handle_delete, handle_mkcol, handle_propfind, handle_proppatch, handle_copy, handle_move } from "./handlers";

const AUTH_REALM = 'ZOTERODAV';
const DAV_CLASS = '1, 3';
const SUPPORTED_METHODS = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'GET', 'HEAD', 'PUT', 'DELETE', 'COPY', 'MOVE'];

async function dispatch_handler(request, env) {
    switch (request.method) {
        case 'OPTIONS': {
            return new Response(null, {
                status: 204,
                headers: {
                    Allow: SUPPORTED_METHODS.join(', '),
                    DAV: DAV_CLASS,
                }
            })
        }
        case 'HEAD': {
            return await handle_head(request, env);
        }
        case 'GET': {
            return await handle_get(request, env);
        }
        case 'PUT': {
            return await handle_put(request, env);
        }
        case 'DELETE': {
            return await handle_delete(request, env);
        }
        case 'MKCOL': {
            return await handle_mkcol(request, env);
        }
        case 'PROPFIND': {
            return await handle_propfind(request, env);
        }
        case 'PROPPATCH': {
            return await handle_proppatch(request, env);
        }
        case 'COPY': {
            return await handle_copy(request, env);
        }
        case 'MOVE': {
            return await handle_move(request, env);
        }
        default: {
            return new Response('Method Not Allowed', {
                status: 405,
                headers: {
                    Allow: SUPPORTED_METHODS.join(', '),
                    DAV: DAV_CLASS,
                },
            });
        }
    }
}

function is_authorized(authorization_header, username, password) {
    const encoder = new TextEncoder();

    const header = encoder.encode(authorization_header);
    const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

    if (header.byteLength !== expected.byteLength) {
        return false; // Length mismatch
    }

    return crypto.subtle.timingSafeEqual(header, expected)
}

export default {
	async fetch(request, env, ctx) {
		// Extract the Authorization header
		const authorization_header = request.headers.get("Authorization") || "";

		if (
            request.method !== 'OPTIONS' &&
            !is_authorized(authorization_header, env.USERNAME, env.PASSWORD)
        ) {
			// Return 401 Unauthorized if credentials are invalid
			return new Response("Unauthorized", {
				status: 401,
				headers: {
					"WWW-Authenticate": `Basic realm="${AUTH_REALM}"`,
				},
			});
		}

        let response = await dispatch_handler(request, env);

        // Set CORS headers
        response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
        response.headers.set('Access-Control-Allow-Methods', SUPPORTED_METHODS.join(', '));
        response.headers.set(
            'Access-Control-Allow-Headers',
            ['authorization', 'content-type', 'depth', 'overwrite', 'destination', 'range'].join(', '),
        );
        response.headers.set(
            'Access-Control-Expose-Headers',
            ['content-type', 'content-length', 'dav', 'etag', 'last-modified', 'location', 'date', 'content-range'].join(
                ', ',
            ),
        );
        response.headers.set('Access-Control-Allow-Credentials', 'false');
        response.headers.set('Access-Control-Max-Age', '86400');

        return response;
	},
};
