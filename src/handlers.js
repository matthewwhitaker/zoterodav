import { corsHeaders, mimeTypes } from './utils'

export async function handle_head(request, env, ctx) {
    let response = await handle_get(request, env, ctx);
    return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    })
}

function make_resource_path(request) {
    let path = new URL(request.url).pathname.slice(1);
    path = path.endsWith('/')? path.slice(0, -1) : path;
    return path;
}

function calcContentRange(object) {
    let rangeOffset = 0;
    let rangeEnd = object.size - 1;
    if (object.range) {
        if ('suffix' in object.range) {
            // Case 3: {suffix: number}
            rangeOffset = object.size - object.range.suffix;
        } else {
            // Case 1: {offset: number, length?: number}
            // Case 2: {offset?: number, length: number}
            rangeOffset = object.range.offset ?? 0;
            let length = object.range.length ?? object.size - rangeOffset;
            rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
        }
    }
    return { rangeOffset, rangeEnd };
}

async function* listAll(bucket, prefix, isRecursive = false) {
    let cursor = undefined;
    do {
        let r2_objects = await bucket.list({
            prefix: prefix,
            delimiter: isRecursive ? undefined : '/',
            cursor: cursor,
            include: ['httpMetadata', 'customMetadata'],
        });

        for (let object of r2_objects.objects) {
            yield object;
        }

        if (r2_objects.truncated) {
            cursor = r2_objects.cursor;
        }
    } while (r2_objects.truncated);
}

export async function handle_get(request, env, ctx) {
    let resource_path = make_resource_path(request);

    if(request.url.endsWith('/')) {
        let page = '';
        let prefix = resource_path;
        if (resource_path !== '') {
            page += `<a href="../">..</a><br>`;
            prefix = `${resource_path}/`;
        }

        for await (const object of listAll(env.MY_BUCKET, prefix)) {
            if (object.key === resource_path) {
                continue;
            }
            let href = `/${object.key + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
            page += `<a href="${href}">${object.httpMetadata?.contentDisposition ?? object.key.slice(prefix.length)}</a><br>`;
        }

        let pageSource = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>R2 WebDAV</title></head><body><h1>R2 WebDAV</h1><div>${page}</div></body></html>`;
        return new Response(pageSource, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    } else {
        let object = await env.MY_BUCKET.get(resource_path, {
            onlyIf: request.headers,
            range: request.headers,
        });

        const isR2ObjectBody = (object) => {
            return 'body' in object;
        }

        if (object === null) {
            return new Response('Not Found', { status: 404 });
        } else if (!isR2ObjectBody(object)) {
            return new Response('Precondition Failed', { status: 412 });
        } else {
            const { rangeOffset, rangeEnd } = calcContentRange(object);
            const contentLength = rangeEnd - rangeOffset + 1;
            return new Response(object.body, {
                status: object.range && contentLength !== object.size ? 206 : 200,
                headers: {
                    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
                    'Content-Length': contentLength.toString(),
                    ...{ 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` },
                    ...(object.httpMetadata?.contentDisposition
                        ? {
                            'Content-Disposition': object.httpMetadata.contentDisposition,
                        }
                        : {}),
                    ...(object.httpMetadata?.contentEncoding
                        ? {
                            'Content-Encoding': object.httpMetadata.contentEncoding,
                        }
                        : {}),
                    ...(object.httpMetadata?.contentLanguage
                        ? {
                            'Content-Language': object.httpMetadata.contentLanguage,
                        }
                        : {}),
                    ...(object.httpMetadata?.cacheControl
                        ? {
                            'Cache-Control': object.httpMetadata.cacheControl,
                        }
                        : {}),
                    ...(object.httpMetadata?.cacheExpiry
                        ? {
                            'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
                        }
                        : {}),
                },
            });
        }
    }
}

export async function handle_put(request, env, ctx) {
    if (request.url.endsWith('/')) {
        return new Response('Method Not Allowed', { status: 405 });
    }

    let resource_path = make_resource_path(request);
    let bucket = env.MY_BUCKET;

    // Check if the parent directory exists
    let dirpath = resource_path.split('/').slice(0, -1).join('/');
    if (dirpath !== '') {
        let dir = await bucket.head(dirpath);
        if (!(dir && dir.customMetadata?.resourcetype === '<collection />')) {
            return new Response('Conflict', { status: 409 });
        }
    }

    let body = await request.arrayBuffer();
    await bucket.put(resource_path, body, {
        onlyIf: request.headers,
        httpMetadata: request.headers,
    });
    return new Response('', { status: 201 });
}

export async function handle_delete(request, env, ctx) {
    let resource_path = make_resource_path(request);
    let bucket = env.MY_BUCKET;

    if (resource_path === '') {
        let r2_objects,
            cursor = undefined;
        do {
            r2_objects = await bucket.list({ cursor: cursor });
            let keys = r2_objects.objects.map((object) => object.key);
            if (keys.length > 0) {
                await bucket.delete(keys);
            }

            if (r2_objects.truncated) {
                cursor = r2_objects.cursor;
            }
        } while (r2_objects.truncated);

        return new Response(null, { status: 204 });
    }

    let resource = await bucket.head(resource_path);
    if (resource === null) {
        return new Response('Not Found', { status: 404 });
    }
    await bucket.delete(resource_path);
    if (resource.customMetadata?.resourcetype !== '<collection />') {
        return new Response(null, { status: 204 });
    }

    let r2_objects,
        cursor = undefined;
    do {
        r2_objects = await bucket.list({
            prefix: resource_path + '/',
            cursor: cursor,
        });
        let keys = r2_objects.objects.map((object) => object.key);
        if (keys.length > 0) {
            await bucket.delete(keys);
        }

        if (r2_objects.truncated) {
            cursor = r2_objects.cursor;
        }
    } while (r2_objects.truncated);

    return new Response(null, { status: 204 });
}

export async function handle_mkcol(request, env, ctx) {
    let resource_path = make_resource_path(request);
    let bucket = env.MY_BUCKET;

    // Check if the resource already exists
    let resource = await bucket.head(resource_path);
    if (resource !== null) {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // Check if the parent directory exists
    let parent_dir = resource_path.split('/').slice(0, -1).join('/');

    if (parent_dir !== '' && !(await bucket.head(parent_dir))) {
        return new Response('Conflict', { status: 409 });
    }

    await bucket.put(resource_path, new Uint8Array(), {
        httpMetadata: request.headers,
        customMetadata: { resourcetype: '<collection />' },
    });
    return new Response('', { status: 201 });
}

function fromR2Object(object) {
    if (object === null || object === undefined) {
        return {
            creationdate: new Date().toUTCString(),
            displayname: undefined,
            getcontentlanguage: undefined,
            getcontentlength: '0',
            getcontenttype: undefined,
            getetag: undefined,
            getlastmodified: new Date().toUTCString(),
            resourcetype: '<collection />',
        };
    }

    return {
        creationdate: object.uploaded.toUTCString(),
        displayname: object.httpMetadata?.contentDisposition,
        getcontentlanguage: object.httpMetadata?.contentLanguage,
        getcontentlength: object.size.toString(),
        getcontenttype: object.httpMetadata?.contentType,
        getetag: object.etag,
        getlastmodified: object.uploaded.toUTCString(),
        resourcetype: object.customMetadata?.resourcetype ?? '',
    };
}

function generate_propfind_response(object) {
    if (object === null) {
        return `
	<response>
		<href>/</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(null))
            .filter(([_, value]) => value !== undefined)
            .map(([key, value]) => `<${key}>${value}</${key}>`)
            .join('\n				')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
    }

    let href = `/${object.key + (object.customMetadata?.resourcetype === '<collection />' ? '/' : '')}`;
    return `
	<response>
		<href>${href}</href>
		<propstat>
			<prop>
			${Object.entries(fromR2Object(object))
        .filter(([_, value]) => value !== undefined)
        .map(([key, value]) => `<${key}>${value}</${key}>`)
        .join('\n				')}
			</prop>
			<status>HTTP/1.1 200 OK</status>
		</propstat>
	</response>`;
}

export async function handle_propfind(request, env, ctx) {
    let resource_path = make_resource_path(request);
    let bucket = env.MY_BUCKET;

    let is_collection;
    let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

    if (resource_path === '') {
        page += generate_propfind_response(null);
        is_collection = true;
    } else {
        let object = await bucket.head(resource_path);
        if (object === null) {
            return new Response('Not Found', { status: 404 });
        }
        is_collection = object.customMetadata?.resourcetype === '<collection />';
        page += generate_propfind_response(object);
    }

    if (is_collection) {
        let depth = request.headers.get('Depth') ?? 'infinity';
        switch (depth) {
            case '0':
                break;
            case '1':
            {
                let prefix = resource_path === '' ? resource_path : resource_path + '/';
                for await (let object of listAll(bucket, prefix)) {
                    page += generate_propfind_response(object);
                }
            }
                break;
            case 'infinity':
            {
                let prefix = resource_path === '' ? resource_path : resource_path + '/';
                for await (let object of listAll(bucket, prefix, true)) {
                    page += generate_propfind_response(object);
                }
            }
                break;
            default: {
                return new Response('Forbidden', { status: 403 });
            }
        }
    }

    page += '\n</multistatus>\n';
    return new Response(page, {
        status: 207,
        headers: {
            'Content-Type': 'text/xml',
        },
    });
}

export async function handle_proppatch(request, env, ctx) {
    const resource_path = make_resource_path(request);
    const bucket = env.MY_BUCKET;

    let object = await bucket.head(resource_path);
    if (object === null) {
        return new Response('Not Found', { status: 404 });
    }

    const body = await request.text();

    const setProperties = {};
    const removeProperties = [];
    let currentAction = null;
    let currentPropName = null;
    let currentPropValue = '';

    class PropHandler {
        element(element) {
            const tagName = element.tagName.toLowerCase();
            if (tagName === 'set') {
                currentAction = 'set';
            } else if (tagName === 'remove') {
                currentAction = 'remove';
            } else if (tagName === 'prop') {
                // ignore <prop>
            } else {
                currentPropName = tagName;
                currentPropValue = '';
            }
        }

        text(textChunk) {
            if (currentPropName) {
                currentPropValue += textChunk.text;
            }
        }

        end(element) {
            if (currentAction === 'set' && currentPropName) {
                setProperties[currentPropName] = currentPropValue.trim();
            } else if (currentAction === 'remove' && currentPropName) {
                removeProperties.push(currentPropName);
            }
            currentPropName = null;
            currentPropValue = '';
        }
    }

    await new HTMLRewriter().on('propertyupdate', new PropHandler()).transform(new Response(body)).arrayBuffer();

    // Copy the original custom metadata
    const customMetadata = object.customMetadata ? { ...object.customMetadata } : {};

    // Update metadata
    for (const propName in setProperties) {
        customMetadata[propName] = setProperties[propName];
    }

    for (const propName of removeProperties) {
        delete customMetadata[propName];
    }

    // Update object metadata
    const src = await bucket.get(object.key);
    if (src === null) {
        return new Response('Not Found', { status: 404 });
    }

    await bucket.put(object.key, src.body, {
        httpMetadata: object.httpMetadata,
        customMetadata: customMetadata,
    });

    // Construct a response
    let responseXML = '<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n';

    for (const propName in setProperties) {
        responseXML += `
    <response>
        <href>/${object.key}</href>
        <propstat>
            <prop>
                <${propName} />
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>\n`;
    }

    for (const propName of removeProperties) {
        responseXML += `
    <response>
        <href>/${object.key}</href>
        <propstat>
            <prop>
                <${propName} />
            </prop>
            <status>HTTP/1.1 200 OK</status>
        </propstat>
    </response>\n`;
    }

    responseXML += '</multistatus>';

    return new Response(responseXML, {
        status: 207,
        headers: {
            'Content-Type': 'application/xml; charset="utf-8"',
        },
    });
}

export async function handle_copy(request, env, ctx) {
    let resource_path = make_resource_path(request);
    let bucket = env.MY_BUCKET;
    let dont_overwrite = request.headers.get('Overwrite') === 'F';
    let destination_header = request.headers.get('Destination');
    if (destination_header === null) {
        return new Response('Bad Request', { status: 400 });
    }
    let destination = new URL(destination_header).pathname.slice(1);
    destination = destination.endsWith('/') ? destination.slice(0, -1) : destination;

    // Check if the parent directory exists
    let destination_parent = destination
        .split('/')
        .slice(0, destination.endsWith('/') ? -2 : -1)
        .join('/');
    if (destination_parent !== '' && !(await bucket.head(destination_parent))) {
        return new Response('Conflict', { status: 409 });
    }

    // Check if the destination already exists
    let destination_exists = await bucket.head(destination);
    if (dont_overwrite && destination_exists) {
        return new Response('Precondition Failed', { status: 412 });
    }

    let resource = await bucket.head(resource_path);
    if (resource === null) {
        return new Response('Not Found', { status: 404 });
    }

    let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

    if (is_dir) {
        let depth = request.headers.get('Depth') ?? 'infinity';
        switch (depth) {
            case 'infinity': {
                let prefix = resource_path + '/';
                const copy = async (object) => {
                    let target = destination + '/' + object.key.slice(prefix.length);
                    target = target.endsWith('/') ? target.slice(0, -1) : target;
                    let src = await bucket.get(object.key);
                    if (src !== null) {
                        await bucket.put(target, src.body, {
                            httpMetadata: object.httpMetadata,
                            customMetadata: object.customMetadata,
                        });
                    }
                };
                let promise_array = [copy(resource)];
                for await (let object of listAll(bucket, prefix, true)) {
                    promise_array.push(copy(object));
                }
                await Promise.all(promise_array);
                if (destination_exists) {
                    return new Response(null, { status: 204 });
                } else {
                    return new Response('', { status: 201 });
                }
            }
            case '0': {
                let object = await bucket.get(resource.key);
                if (object === null) {
                    return new Response('Not Found', { status: 404 });
                }
                await bucket.put(destination, object.body, {
                    httpMetadata: object.httpMetadata,
                    customMetadata: object.customMetadata,
                });
                if (destination_exists) {
                    return new Response(null, { status: 204 });
                } else {
                    return new Response('', { status: 201 });
                }
            }
            default: {
                return new Response('Bad Request', { status: 400 });
            }
        }
    } else {
        let src = await bucket.get(resource.key);
        if (src === null) {
            return new Response('Not Found', { status: 404 });
        }
        await bucket.put(destination, src.body, {
            httpMetadata: src.httpMetadata,
            customMetadata: src.customMetadata,
        });
        if (destination_exists) {
            return new Response(null, { status: 204 });
        } else {
            return new Response('', { status: 201 });
        }
    }
}

export async function handle_move(request, env, ctx) {
    let resource_path = make_resource_path(request);
    let bucket = env.MY_BUCKET;
    let overwrite = request.headers.get('Overwrite') === 'T';
    let destination_header = request.headers.get('Destination');
    if (destination_header === null) {
        return new Response('Bad Request', { status: 400 });
    }
    let destination = new URL(destination_header).pathname.slice(1);
    destination = destination.endsWith('/') ? destination.slice(0, -1) : destination;

    // Check if the parent directory exists
    let destination_parent = destination
        .split('/')
        .slice(0, destination.endsWith('/') ? -2 : -1)
        .join('/');
    if (destination_parent !== '' && !(await bucket.head(destination_parent))) {
        return new Response('Conflict', { status: 409 });
    }

    // Check if the destination already exists
    let destination_exists = await bucket.head(destination);
    if (!overwrite && destination_exists) {
        return new Response('Precondition Failed', { status: 412 });
    }

    let resource = await bucket.head(resource_path);
    if (resource === null) {
        return new Response('Not Found', { status: 404 });
    }
    if (resource.key === destination) {
        return new Response('Bad Request', { status: 400 });
    }

    if (destination_exists) {
        // Delete the destination first
        await handle_delete(new Request(new URL(destination_header), request), bucket);
    }

    let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

    if (is_dir) {
        let depth = request.headers.get('Depth') ?? 'infinity';
        switch (depth) {
            case 'infinity': {
                let prefix = resource_path + '/';
                const move = async (object) => {
                    let target = destination + '/' + object.key.slice(prefix.length);
                    target = target.endsWith('/') ? target.slice(0, -1) : target;
                    let src = await bucket.get(object.key);
                    if (src !== null) {
                        await bucket.put(target, src.body, {
                            httpMetadata: object.httpMetadata,
                            customMetadata: object.customMetadata,
                        });
                        await bucket.delete(object.key);
                    }
                };
                let promise_array = [move(resource)];
                for await (let object of listAll(bucket, prefix, true)) {
                    promise_array.push(move(object));
                }
                await Promise.all(promise_array);
                if (destination_exists) {
                    return new Response(null, { status: 204 });
                } else {
                    return new Response('', { status: 201 });
                }
            }
            case '0': {
                let object = await bucket.get(resource.key);
                if (object === null) {
                    return new Response('Not Found', { status: 404 });
                }
                await bucket.put(destination, object.body, {
                    httpMetadata: object.httpMetadata,
                    customMetadata: object.customMetadata,
                });
                await bucket.delete(resource.key);
                if (destination_exists) {
                    return new Response(null, { status: 204 });
                } else {
                    return new Response('', { status: 201 });
                }
            }
            default: {
                return new Response('Bad Request', { status: 400 });
            }
        }
    } else {
        let src = await bucket.get(resource.key);
        if (src === null) {
            return new Response('Not Found', { status: 404 });
        }
        await bucket.put(destination, src.body, {
            httpMetadata: src.httpMetadata,
            customMetadata: src.customMetadata,
        });
        await bucket.delete(resource.key);
        if (destination_exists) {
            return new Response(null, { status: 204 });
        } else {
            return new Response('', { status: 201 });
        }
    }
}