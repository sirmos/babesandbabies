const numberWords = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10]
]);

const productAliases = {
  baby_lotion: ['baby lotion', 'lotion'],
  bath_gel: ['bath gel', 'soap', 'body wash'],
  baby_powder: ['baby powder', 'powder'],
  petroleum_jelly: ['petroleum jelly', 'jelly', 'vaseline'],
  baby_shampoo: ['baby shampoo', 'shampoo'],
  baby_oil: ['baby oil', 'oil'],
  diaper_rash_cream: ['diaper rash cream', 'rash cream', 'diaper cream', 'nappy cream'],
  booking_deposit: ['booking deposit', 'deposit', 'booking']
};

const pidginSignals = [
  'abeg', 'oya', 'wan', 'dey', 'na', 'wetin', 'una', 'sef', 'don', 'no fit', 'make i', 'comot', 'carry'
];
const leadingFillers = [
  'make you', 'make i', 'please', 'sister', 'madam', 'hello', 'kindly', 'abeg', 'plz', 'pls', 'oya', 'hey', 'sis', 'ma', 'hi', 'so'
].sort((first, second) => second.length - first.length);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function catalogList(catalog) {
  return catalog.map((item) => `${item.name} ($${Number(item.price).toFixed(2)})`).join(', ');
}

export function sanitizeAgentNote(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
}

function makeReply(language, pidgin, english) {
  return language === 'pidgin' ? pidgin : english;
}

function normalizeMessage(message) {
  let normalized = String(message || '').toLowerCase().trim()
    .replace(/[,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let removedFiller = true;
  while (normalized && removedFiller) {
    removedFiller = false;
    for (const filler of leadingFillers) {
      const prefix = new RegExp(`^${escapeRegExp(filler)}(?:\\s+|$)`);
      if (prefix.test(normalized)) {
        normalized = normalized.replace(prefix, '').trim();
        removedFiller = true;
        break;
      }
    }
  }
  return normalized;
}

export function detectAgentLanguage(rawMessage) {
  const raw = String(rawMessage || '').toLowerCase();
  return pidginSignals.some((signal) => new RegExp(`(?:^|\\b)${escapeRegExp(signal)}(?:\\b|$)`).test(raw))
    ? 'pidgin'
    : 'english';
}

function asksForPrivateInstructions(message) {
  return /\b(reveal|show|tell me|print|repeat)\b.{0,60}\b(system prompt|instructions?|hidden prompt)\b/i.test(message);
}

function isPriceManipulationRequest(message) {
  return /\b(change|lower|reduce|set|override|adjust|make)\b.{0,50}\b(prices?|costs?|cheaper)\b|\b(?:\d{1,3}\s*%|%|percent(?:age)?)\s*(?:off|discount)\b|\b(?:discount|free|complimentary)\b/i.test(message);
}

export function isAgentSafetyRequest(message) {
  return /\b(ignore|disregard|override)\b.{0,60}\b(instructions?|rules?|prompt)\b/i.test(message)
    || asksForPrivateInstructions(message)
    || isPriceManipulationRequest(message);
}

export function agentSafetyReply(message, catalog, language = detectAgentLanguage(message)) {
  const list = catalogList(catalog);
  if (asksForPrivateInstructions(message)) {
    return makeReply(language,
      `I no fit share private instructions. Na this we get: ${list}.`,
      `I can't share private instructions. Our catalogue is: ${list}.`);
  }
  if (isPriceManipulationRequest(message)) {
    return makeReply(language,
      `Our prices dey fixed o, I no fit change am or give discount. Na this we get: ${list}.`,
      `Our prices are fixed. I can't change them or give discounts. Our catalogue is: ${list}.`);
  }
  return makeReply(language, `I no fit do that one. Na this we get: ${list}.`, `I can't help with that request. Our catalogue is: ${list}.`);
}

function compileProductMatcher() {
  const alternatives = Object.entries(productAliases)
    .flatMap(([id, aliases]) => aliases.map((alias) => ({ id, alias })))
    .sort((first, second) => second.alias.length - first.alias.length);
  const pattern = alternatives.map(({ alias }) => escapeRegExp(alias).replace(/\ /g, '\\s+') + '(?:s|es)?').join('|');
  const idsByAlias = new Map(alternatives.map(({ id, alias }) => [alias, id]));
  return { regex: new RegExp(`\\b(${pattern})\\b`, 'gi'), idsByAlias };
}

function readQuantity(normalized, match, matchText) {
  const words = [...numberWords.keys()].join('|');
  const before = normalized.slice(Math.max(0, match.index - 18), match.index);
  const preceding = before.match(new RegExp(`(?:^|\\s)(?:x\\s*)?(\\d+|${words})x?\\s*$`, 'i'));
  if (preceding) return Number(preceding[1]) || numberWords.get(preceding[1].toLowerCase());
  const after = normalized.slice(match.index + matchText.length, match.index + matchText.length + 14);
  const following = after.match(new RegExp(`^\\s*(?:x\\s*)?(\\d+|${words})x?\\b`, 'i'));
  if (following) return Number(following[1]) || numberWords.get(following[1].toLowerCase());
  return 1;
}

function findProductMentions(normalized) {
  const { regex, idsByAlias } = compileProductMatcher();
  const mentions = [];
  for (const match of normalized.matchAll(regex)) {
    const alias = match[1].replace(/\s+/g, ' ').replace(/(?:s|es)$/i, '').trim();
    const id = idsByAlias.get(alias) || idsByAlias.get(match[1].replace(/\s+/g, ' ').trim());
    if (!id) continue;
    mentions.push({ id, index: match.index, qty: readQuantity(normalized, match, match[0]) });
  }
  return mentions;
}

function findStyle(text, styleTitles) {
  const normalized = text.toLowerCase();
  return [...styleTitles].sort((first, second) => second.length - first.length)
    .find((title) => normalized.includes(title.toLowerCase())) || '';
}

function getBookingStyle(text, styleTitles, context, state, sanitizeNote) {
  const title = findStyle(text, styleTitles);
  const customStyle = text.match(/\bfor\s+(.+?)(?:[,.!?]|$)/i)?.[1];
  return sanitizeNote(title || customStyle || context.style || state.note || '');
}

function askForStyle(styleTitles, language) {
  const examples = styleTitles.slice(0, 3).join(', ');
  return makeReply(language,
    `Which style you want? Examples: ${examples}.`,
    `Which style would you like? Examples: ${examples}.`);
}

function cartSummary(state, catalog, language, getCartDetails) {
  const details = getCartDetails(state.cart);
  if (!details.items.length) {
    return makeReply(language, 'Your cart empty.', 'Your cart is empty.');
  }
  const contents = details.items.map((item) => `${item.qty} ${item.name}`).join(', ');
  return language === 'pidgin'
    ? `Your cart get: ${contents}. Total na $${details.total.toFixed(2)}.`
    : `Your cart has: ${contents}. Total: $${details.total.toFixed(2)}.`;
}

export function parseLocalIntent({
  message,
  state,
  catalog,
  styleTitles = [],
  context = {},
  sanitizeNote = sanitizeAgentNote,
  getCartDetails
}) {
  const language = detectAgentLanguage(message);
  const normalized = normalizeMessage(message);
  const mentions = findProductMentions(normalized);
  const hasAddIntent = /\b(add|put|get|give me|i need|i want|i wan|i dey need|buy|order|send me|bring|carry)\b/.test(normalized);
  const hasRemoveIntent = /\b(remove|delete|take out|comot)\b/.test(normalized);
  const clearCart = /\bclear\s+(?:my\s+)?cart\b/.test(normalized);
  const showCart = /\b(?:show|view)\s+(?:my\s+)?cart\b|\bwhat'?s\s+in\s+(?:my\s+)?cart\b/.test(normalized);
  const checkout = /\b(?:pay|checkout|check out)\b|\bi\s+want\s+to\s+pay\b/.test(normalized);
  const bookingIntent = /\b(deposit|booking|book|appointment)\b/.test(normalized);
  const title = findStyle(normalized, styleTitles);
  const genericBraiding = /\b(braiding|braid)\b/.test(normalized) && !title;
  const asksForBooking = bookingIntent || genericBraiding;
  const hasShoppingIntent = hasAddIntent || hasRemoveIntent || asksForBooking;

  if (clearCart) {
    state.cart = [];
    state.note = '';
    state.readyForCheckout = false;
    return { handled: true, language, actions: [{ type: 'clear' }], reply: makeReply(language, 'I don clear your cart.', 'Your cart is clear.') };
  }
  if (showCart) return { handled: true, language, actions: [], reply: cartSummary(state, catalog, language, getCartDetails) };
  if (checkout) {
    if (!state.cart.length) return { handled: true, language, actions: [], reply: makeReply(language, 'Your cart empty. Add something first.', 'Your cart is empty. Add something first.') };
    state.readyForCheckout = true;
    if (state.cart.some((item) => item.id === 'booking_deposit') && context.style) state.note = sanitizeNote(context.style);
    return { handled: true, language, actions: [{ type: 'checkout' }], reply: makeReply(language, 'Your cart ready. Review am, then tap the PayPal button when you ready.', 'Your cart is ready. Review it, then tap the PayPal button when you are ready.') };
  }

  if (asksForBooking) {
    const style = getBookingStyle(message, styleTitles, context, state, sanitizeNote);
    if (!style) return { handled: true, language, actions: [], reply: askForStyle(styleTitles, language) };
    const deposit = catalog.find((item) => item.id === 'booking_deposit');
    let depositLine = state.cart.find((item) => item.id === 'booking_deposit');
    if (!depositLine && state.cart.length >= 10) {
      return { handled: true, language, actions: [], reply: makeReply(language, 'Your cart don reach the 10-item limit.', 'Your cart has reached its 10-item limit.') };
    }
    const existing = Boolean(depositLine);
    if (depositLine) depositLine.qty = 1;
    else {
      depositLine = { id: deposit.id, qty: 1 };
      state.cart.push(depositLine);
    }
    state.note = style;
    const reply = existing
      ? makeReply(language, `I don update your booking style to ${style}.`, `Updated your booking style to ${style}.`)
      : makeReply(language, `I don add 1 ${deposit.name} to your cart.`, `Added 1 ${deposit.name} to your cart.`);
    return { handled: true, language, actions: [{ type: existing ? 'update' : 'add', id: deposit.id, qty: 1, note: style }], reply };
  }

  if (hasRemoveIntent) {
    if (!mentions.length) return { handled: true, language, actions: [], reply: makeReply(language, `Which one you mean? We get: ${catalogList(catalog)}.`, `Which item do you mean? We have: ${catalogList(catalog)}.`) };
    const removed = [];
    for (const { id } of mentions) {
      const product = catalog.find((item) => item.id === id);
      const previousLength = state.cart.length;
      state.cart = state.cart.filter((item) => item.id !== id);
      if (state.cart.length !== previousLength) {
        removed.push(product);
        if (id === 'booking_deposit') state.note = '';
      }
    }
    if (!removed.length) return { handled: true, language, actions: [], reply: makeReply(language, 'That item no dey your cart.', 'That item is not in your cart.') };
    return {
      handled: true,
      language,
      actions: removed.map((item) => ({ type: 'remove', id: item.id })),
      reply: removed.map((item) => makeReply(language, `I don comot ${item.name} from your cart.`, `Removed ${item.name} from your cart.`)).join(' ')
    };
  }

  if (hasAddIntent) {
    if (!mentions.length) return { handled: true, language, actions: [], reply: makeReply(language, `Which one you mean? We get: ${catalogList(catalog)}.`, `Which item do you mean? We have: ${catalogList(catalog)}.`) };
    const quantities = new Map();
    for (const mention of mentions) {
      const current = quantities.get(mention.id) || 0;
      quantities.set(mention.id, current + mention.qty);
    }
    if ([...quantities.values()].some((qty) => qty > 10)) {
      return { handled: true, language, actions: [], reply: makeReply(language, 'Ten na the most for one time. Abeg pick small.', 'Ten is the maximum at one time. Please choose a smaller quantity.') };
    }
    const bookingStyle = quantities.has('booking_deposit')
      ? getBookingStyle(message, styleTitles, context, state, sanitizeNote)
      : '';
    if (quantities.has('booking_deposit') && !bookingStyle) {
      return { handled: true, language, actions: [], reply: askForStyle(styleTitles, language) };
    }
    if (quantities.has('booking_deposit') && quantities.get('booking_deposit') !== 1) {
      return { handled: true, language, actions: [], reply: makeReply(language, 'One booking deposit cover any style. Abeg pick one.', 'One booking deposit covers any style. Please choose one.') };
    }
    const currentIds = new Set(state.cart.map((item) => item.id));
    const nextIds = new Set([...currentIds, ...quantities.keys()]);
    if (nextIds.size > 10) {
      return { handled: true, language, actions: [], reply: makeReply(language, 'Your cart don reach the 10-item limit.', 'Your cart has reached its 10-item limit.') };
    }
    for (const [id, qty] of quantities) {
      const existing = state.cart.find((item) => item.id === id);
      if (id !== 'booking_deposit' && (existing?.qty || 0) + qty > 10) {
        return { handled: true, language, actions: [], reply: makeReply(language, 'Ten na the most for one time. Abeg pick small.', 'Ten is the maximum at one time. Please choose a smaller quantity.') };
      }
    }
    const actions = [];
    for (const [id, qty] of quantities) {
      const product = catalog.find((item) => item.id === id);
      const existing = state.cart.find((item) => item.id === id);
      if (id === 'booking_deposit') {
        if (existing) existing.qty = 1;
        else state.cart.push({ id, qty: 1 });
        state.note = bookingStyle;
      } else if (existing) existing.qty += qty;
      else state.cart.push({ id, qty });
      actions.push({ type: existing ? 'update' : 'add', id, qty: id === 'booking_deposit' ? 1 : qty, note: id === 'booking_deposit' ? state.note : '' });
    }
    return {
      handled: true,
      language,
      actions,
      reply: actions.map((action) => {
        const name = catalog.find((item) => item.id === action.id).name;
        if (action.type === 'update') return makeReply(language, `I don update ${name} for ${state.note}.`, `Updated ${name} for ${state.note}.`);
        return makeReply(language, `I don add ${action.qty} ${name} to your cart.`, `Added ${action.qty} ${name} to your cart.`);
      }).join(' ')
    };
  }

  if (asksForBooking || hasShoppingIntent) {
    return { handled: true, language, actions: [], reply: makeReply(language, `Which one you mean? We get: ${catalogList(catalog)}.`, `Which item do you mean? We have: ${catalogList(catalog)}.`) };
  }
  return { handled: false, language, actions: [], reply: '' };
}