import catalog from './catalog.json';

const paypalTokenCache = {
  token: null,
  expiresAt: 0
};

const getPayPalBaseUrl = (env) => env.PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const jsonResponse = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    ...extraHeaders,
    ...{
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, PayPal-Request-Id',
      'Content-Type': 'application/json'
    }
  }
});

async function getPayPalAccessToken(env) {
  if (paypalTokenCache.token && Date.now() < paypalTokenCache.expiresAt - 30_000) {
    return paypalTokenCache.token;
  }

  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials are not configured');
  }

  const baseUrl = getPayPalBaseUrl(env);
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    console.error('PayPal OAuth upstream response:', {
      status: response.status,
      statusText: response.statusText,
      body: data
    });
    throw new Error('PayPal authentication failed');
  }

  paypalTokenCache.token = data.access_token;
  paypalTokenCache.expiresAt = Date.now() + (Number(data.expires_in) || 300) * 1000;
  return paypalTokenCache.token;
}

function validateCatalogItems(items) {
  const catalogMap = new Map(catalog.map((entry) => [entry.id, entry]));
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Missing items');
  }
  if (items.length > 10) {
    throw new Error('Maximum 10 line items');
  }

  const normalizedItems = [];
  for (const item of items) {
    const itemId = typeof item?.id === 'string' ? item.id.trim() : '';
    const qty = Number(item?.qty);

    if (!itemId || !catalogMap.has(itemId)) {
      throw new Error(`Unknown product id: ${itemId || 'missing'}`);
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      throw new Error(`Invalid quantity for ${itemId}`);
    }

    const product = catalogMap.get(itemId);
    normalizedItems.push({
      id: itemId,
      name: product.name,
      description: product.description,
      qty,
      price: Number(product.price),
      lineTotal: Number(product.price) * qty
    });
  }

  return normalizedItems;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, PayPal-Request-Id',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/shop/catalog' && request.method === 'GET') {
        return jsonResponse(
          catalog.map(({ id, name, price, type, description, image }) => ({
            id,
            name,
            price,
            type,
            description,
            image: image ? new URL(image, 'https://babesandbabies-dcb39.web.app/').href : null
          })),
          200,
          corsHeaders
        );
      }

      if (path === '/paypal/config' && request.method === 'GET') {
        if (!env.PAYPAL_CLIENT_ID) {
          return jsonResponse({ error: 'PayPal client ID is not configured' }, 500, corsHeaders);
        }
        return jsonResponse({ clientId: env.PAYPAL_CLIENT_ID }, 200, corsHeaders);
      }

      if (path === '/paypal/create-order' && request.method === 'POST') {
        let payload;
        try {
          payload = await request.json();
        } catch (error) {
          return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
        }

        let normalizedItems;
        try {
          normalizedItems = validateCatalogItems(payload?.items || []);
        } catch (error) {
          return jsonResponse({ error: error.message }, 400, corsHeaders);
        }

        const subtotal = normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0);
        const total = subtotal.toFixed(2);
        const orderNote = typeof payload?.note === 'string' && payload.note.trim() ? payload.note.trim() : '';

        const accessToken = await getPayPalAccessToken(env);
        const baseUrl = getPayPalBaseUrl(env);
        const requestId = crypto.randomUUID();
        const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'PayPal-Request-Id': requestId
          },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [{
              reference_id: 'babes-and-babies-order',
              description: orderNote || 'Babes & Babies checkout',
              amount: {
                currency_code: 'USD',
                value: total,
                breakdown: {
                  item_total: {
                    currency_code: 'USD',
                    value: normalizedItems.reduce((sum, item) => sum + item.lineTotal, 0).toFixed(2)
                  }
                }
              },
              items: normalizedItems.map((item) => ({
                name: item.name,
                description: item.description,
                quantity: String(item.qty),
                unit_amount: {
                  currency_code: 'USD',
                  value: item.price.toFixed(2)
                },
                category: 'PHYSICAL_GOODS'
              }))
            }],
            application_context: {
              brand_name: 'Babes & Babies',
              landing_page: 'NO_PREFERENCE',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING'
            }
          })
        });

        const responseText = await response.text();
        let responseBody;
        try {
          responseBody = JSON.parse(responseText);
        } catch (error) {
          responseBody = { raw: responseText };
        }

        if (!response.ok || !responseBody.id) {
          console.error('PayPal create-order upstream response:', {
            status: response.status,
            statusText: response.statusText,
            body: responseBody
          });
          return jsonResponse({ error: 'Order creation failed' }, 502, corsHeaders);
        }

        return jsonResponse({
          orderId: responseBody.id,
          total,
          items: normalizedItems.map((item) => ({
            id: item.id,
            name: item.name,
            qty: item.qty,
            total: item.lineTotal.toFixed(2)
          }))
        }, 200, corsHeaders);
      }

      if (path === '/paypal/capture-order' && request.method === 'POST') {
        let payload;
        try {
          payload = await request.json();
        } catch (error) {
          return jsonResponse({ error: 'Invalid JSON body' }, 400, corsHeaders);
        }

        const orderId = typeof payload?.orderId === 'string' ? payload.orderId.trim() : '';
        if (!orderId) {
          return jsonResponse({ error: 'Missing orderId' }, 400, corsHeaders);
        }

        const accessToken = await getPayPalAccessToken(env);
        const baseUrl = getPayPalBaseUrl(env);
        const response = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });

        const responseText = await response.text();
        let responseBody;
        try {
          responseBody = JSON.parse(responseText);
        } catch (error) {
          responseBody = { raw: responseText };
        }

        if (!response.ok) {
          console.error('PayPal capture-order upstream response:', {
            status: response.status,
            statusText: response.statusText,
            body: responseBody
          });
          return jsonResponse({ error: 'Capture failed' }, 502, corsHeaders);
        }

        const capture = responseBody.purchase_units?.[0]?.payments?.captures?.[0];
        const amount = capture?.amount?.value || '0.00';
        const payerName = [
          responseBody.payer?.name?.given_name,
          responseBody.payer?.name?.surname
        ].filter(Boolean).join(' ') || 'PayPal customer';

        return jsonResponse({
          status: responseBody.status || 'UNKNOWN',
          orderId,
          amount,
          payerName
        }, 200, corsHeaders);
      }

      // Existing Gemini chat
      if (path === '/' || path === '') {
        const { systemPrompt, history, userMsg } = await request.json();
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: systemPrompt + '\n' + userMsg }] }]
            })
          }
        );
        const data = await response.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (reply) return new Response(JSON.stringify({ reply }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
        return new Response(JSON.stringify({ reply: 'Error: ' + JSON.stringify(data) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/youcam/hair-templates' && request.method === 'GET') {
        const templateEndpoint = 'https://yce-api-01.makeupar.com/s2s/v2.0/task/template/hair-style';
        const templates = [];
        const templateIds = new Set();
        const seenTokens = new Set();
        let startingToken = null;

        for (let page = 0; page < 10; page++) {
          const pageUrl = new URL(templateEndpoint);
          if (startingToken) pageUrl.searchParams.set('starting_token', startingToken);
          const templateRes = await fetch(pageUrl.toString(), {
            headers: { 'Authorization': `Bearer ${env.YOUCAM_API_KEY}` }
          });
          const templateData = await templateRes.json();
          for (const template of templateData.data?.templates || []) {
            const id = template.id ?? template.template_id;
            if (templateIds.has(String(id))) continue;
            templateIds.add(String(id));
            templates.push({
              id,
              title: template.title,
              thumb: template.thumb,
              category_name: template.category_name,
              keep_users_color: template.keep_users_color
            });
          }

          const nextToken = templateData.data?.next_token;
          if (nextToken === undefined || nextToken === null || nextToken === '' || seenTokens.has(String(nextToken))) break;
          seenTokens.add(String(nextToken));
          startingToken = String(nextToken);
        }

        return new Response(JSON.stringify(templates), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // YouCam Hair Try-On
      if (path === '/youcam/hair') {
        const { imageBase64, styleId } = await request.json();
        if (!styleId || typeof styleId !== 'string') return new Response(JSON.stringify({ error: 'Unknown style: ' + styleId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const apiKey = env.YOUCAM_API_KEY;
        const imageBuffer = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
        const fileSize = imageBuffer.length;

        // Step 1 - Get upload URL
        const fileRes = await fetch('https://yce-api-01.makeupar.com/s2s/v2.0/file/hair-style', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: [{ content_type: 'image/jpeg', file_name: 'photo.jpg', file_size: fileSize }] })
        });
        const fileData = await fileRes.json();
        if (fileData.status !== 200) return new Response(JSON.stringify({ error: 'File upload failed: ' + JSON.stringify(fileData) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const fileInfo = fileData.data.files[0];
        const uploadUrl = fileInfo.requests[0].url;
        const fileId = fileInfo.file_id;

        // Step 2 - Upload the image
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(fileSize) },
          body: imageBuffer
        });
        if (!putRes.ok) return new Response(JSON.stringify({ error: 'Upload failed: ' + putRes.status }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        // Step 3 - Run task
        const taskRes = await fetch('https://yce-api-01.makeupar.com/s2s/v2.0/task/hair-style', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ src_file_id: fileId, template_id: styleId })
        });
        const taskData = await taskRes.json();
        if (taskData.status !== 200) return new Response(JSON.stringify({ error: 'Unknown style: ' + styleId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const taskId = taskData.data.task_id;

        // Step 5 - Poll for result
        let resultUrl = null;
        let lastPoll = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const pollRes = await fetch(`https://yce-api-01.makeupar.com/s2s/v2.0/task/hair-style/${taskId}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
          });
          const pollData = await pollRes.json();
          lastPoll = pollData;
          if (pollData.data?.task_status === 'success') {
            const results = pollData.data?.results;
            resultUrl = results?.[0]?.url || (typeof results?.[0] === 'string' ? results[0] : null) || results?.url || (typeof results === 'string' ? results : null);
            break;
          }
          if (pollData.data?.task_status === 'error') break;
        }

        if (!resultUrl) return new Response(JSON.stringify({ error: 'No result URL: ' + JSON.stringify(lastPoll) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

        return new Response(JSON.stringify({ resultUrl }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/youcam/hair-transfer' && request.method === 'POST') {
        const { imageBase64, refUrl, keepMyColor } = await request.json();
        const allowedReferencePrefix = 'https://babesandbabies-dcb39.web.app/';
        if (typeof refUrl !== 'string' || !refUrl.startsWith(allowedReferencePrefix)) {
          return new Response(JSON.stringify({ error: 'Invalid reference URL' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const apiKey = env.YOUCAM_API_KEY;
        const imageBuffer = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
        const fileSize = imageBuffer.length;
        const fileRes = await fetch('https://yce-api-01.makeupar.com/s2s/v2.0/file', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: [{ content_type: 'image/jpeg', file_name: 'photo.jpg', file_size: fileSize }] })
        });
        const fileData = await fileRes.json();
        if (!fileRes.ok || fileData.status !== 200) return new Response(JSON.stringify({ error: 'File upload failed: ' + JSON.stringify(fileData) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

        const fileInfo = fileData.data?.files?.[0];
        if (!fileInfo?.file_id || !fileInfo.requests?.[0]?.url) return new Response(JSON.stringify({ error: 'File upload failed: ' + JSON.stringify(fileData) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
        const fileId = fileInfo.file_id;
        const putRes = await fetch(fileInfo.requests[0].url, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(fileSize) },
          body: imageBuffer
        });
        if (!putRes.ok) return new Response(JSON.stringify({ error: 'Upload failed: ' + putRes.status + ' ' + await putRes.text() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

        const taskRes = await fetch('https://yce-api-01.makeupar.com/s2s/v2.1/task/hair-transfer', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ src_file_id: fileId, ref_file_url: refUrl, hair_color: keepMyColor ? 'src' : 'ref' })
        });
        const taskData = await taskRes.json();
        if (!taskRes.ok || taskData.status !== 200) return new Response(JSON.stringify({ error: 'Task failed: ' + JSON.stringify(taskData) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

        const taskId = taskData.data?.task_id;
        if (!taskId) return new Response(JSON.stringify({ error: 'Task failed: ' + JSON.stringify(taskData) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
        let lastPoll = null;
        let resultUrl = null;
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 3000));
          const pollRes = await fetch(`https://yce-api-01.makeupar.com/s2s/v2.1/task/hair-transfer/${taskId}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
          });
          lastPoll = await pollRes.json();
          if (lastPoll.data?.task_status === 'success') {
            resultUrl = lastPoll.data?.results?.url || lastPoll.data?.results?.[0]?.url;
            break;
          }
          if (lastPoll.data?.task_status === 'error') break;
        }

        if (!resultUrl) return new Response(JSON.stringify({ error: 'Hair transfer failed: ' + JSON.stringify(lastPoll) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
        return new Response(JSON.stringify({ resultUrl }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      if (path === '/youcam/skin') {
        const { imageBase64 } = await request.json();
        const apiKey = env.YOUCAM_API_KEY;
        const imageBuffer = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0));
        const fileSize = imageBuffer.length;

        // Step 1 - Get upload URL
        const fileRes = await fetch('https://yce-api-01.makeupar.com/s2s/v2.0/file/skin-analysis', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: [{ content_type: 'image/jpeg', file_name: 'selfie.jpg', file_size: fileSize }] })
        });
        const fileData = await fileRes.json();
        if (fileData.status !== 200) return new Response(JSON.stringify({ error: 'File upload failed: ' + JSON.stringify(fileData) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const fileInfo = fileData.data.files[0];
        const uploadUrl = fileInfo.requests[0].url;
        const fileId = fileInfo.file_id;

        // Step 2 - Upload image
        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(fileSize) },
          body: imageBuffer
        });
        if (!putRes.ok) return new Response(JSON.stringify({ error: 'Upload failed: ' + putRes.status }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        // Step 3 - Run skin analysis
        const taskRes = await fetch('https://yce-api-01.makeupar.com/s2s/v2.0/task/skin-analysis', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            src_file_id: fileId,
            dst_actions: ['acne', 'moisture', 'texture', 'pore', 'radiance', 'oiliness'],
            format: 'json'
          })
        });
        const taskData = await taskRes.json();
        if (taskData.status !== 200) return new Response(JSON.stringify({ error: 'Task failed: ' + JSON.stringify(taskData) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const taskId = taskData.data.task_id;

        // Step 4 - Poll for result
        let scores = null;
        let lastPoll = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const pollRes = await fetch(`https://yce-api-01.makeupar.com/s2s/v2.0/task/skin-analysis/${taskId}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
          });
          const pollData = await pollRes.json();
          lastPoll = pollData;
          if (pollData.data?.task_status === 'success') {
            const output = pollData.data?.results?.output || [];
            scores = {};
            output.forEach(item => { scores[item.type] = item.ui_score; });
            break;
          }
          if (pollData.data?.task_status === 'error') break;
        }

        if (scores === null) return new Response(JSON.stringify({ error: 'Analysis failed: ' + JSON.stringify(lastPoll) }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

        let recommendation = '';
        let recommendationError;
        if (scores) {
          const productsByScore = {
            oiliness: 'baby powder',
            pore: 'baby powder',
            moisture: 'baby lotion or baby oil',
            texture: 'baby lotion or baby oil',
            acne: 'baby shampoo or Mustela bath gel',
            radiance: 'baby shampoo or Mustela bath gel',
            'rash-prone': 'diaper rash cream',
            rash_prone: 'diaper rash cream'
          };
          const lowestScores = Object.entries(scores)
            .sort((first, second) => Number(first[1]) - Number(second[1]))
            .slice(0, 2);
          const fallbackProducts = [...new Set(lowestScores.map(([type]) => productsByScore[type.toLowerCase()] || 'baby lotion'))];
          if (!fallbackProducts.length) fallbackProducts.push('baby lotion', 'baby powder');
          recommendation = `Based on your two lowest facial skin scores, consider ${fallbackProducts.join(' and ')} as gentle options for your skin that may also be a match for your baby.`;

          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: `These scores are from the MUM's own facial skin analysis (the shopper at Babes and Babies, Nigeria), not the baby's skin: ${JSON.stringify(scores)}. Recommend 2-3 products from our range (Johnson's baby lotion, Mustela bath gel, baby powder, petroleum jelly, baby shampoo, baby oil, diaper rash cream). Because these are baby products, frame them as gentle options mum can also use on her skin and as a match for her baby. Do not claim the scores describe the baby's skin. Reply in plain text only. Do not use Markdown, asterisks, bullet points or headings. Maximum 2 sentences. No prices.` }] }]
              })
            }
          );
          let geminiData;
          try {
            geminiData = await geminiRes.json();
          } catch (error) {
            geminiData = { error: error.message };
          }
          const geminiText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!geminiRes.ok || !geminiText) {
            console.error('Gemini recommendation failed:', geminiData);
            recommendationError = JSON.stringify(geminiData);
          } else {
            recommendation = geminiText.replace(/[\*#`]/g, '').trim();
          }
        }

        const responseData = { scores, recommendation };
        if (recommendationError) responseData.recommendationError = recommendationError;
        return new Response(JSON.stringify(responseData), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } catch (error) {
      return jsonResponse({ error: error.message }, 500, corsHeaders);
    }
  }
};