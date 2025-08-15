const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { URLSearchParams } = require('url');
const app = express();

// Middleware
app.use(express.json());

// Constants
const BASE_URL = 'https://umvvs.tra.go.tz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Configure axios instance
const axiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Origin': BASE_URL,
    'Referer': BASE_URL,
    'X-Requested-With': 'XMLHttpRequest',
    'X-MicrosoftAjax': 'Delta=true',
    'Cache-Control': 'no-cache'
  },
  withCredentials: true
});

// Session management
const sessions = new Map();

// Helper to parse initial state
async function initializeSession() {
  try {
    const response = await axiosInstance.get('/');
    const cookies = response.headers['set-cookie'] || [];
    const $ = cheerio.load(response.data);
    
    const sessionId = generateSessionId();
    const state = {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || 'CA0B0334',
      eventValidation: $('input#__EVENTVALIDATION').val(),
      antiXsrfToken: $('input[name="__RequestVerificationToken"]').val() || '',
      cookies: cookies,
      lastResponse: response.data
    };
    
    sessions.set(sessionId, state);
    return { sessionId, state };
  } catch (error) {
    console.error('Session initialization failed:', error);
    throw error;
  }
}

// Helper to make ASP.NET post requests
async function postFormData(sessionId, payload) {
  const state = sessions.get(sessionId);
  if (!state) throw new Error('Invalid session ID');

  const formData = new URLSearchParams();
  
  // Required ASP.NET fields
  formData.append('ctl00$ctl08', `ctl00$MainContent$ddlPanel|${payload.__EVENTTARGET}`);
  formData.append('__EVENTTARGET', payload.__EVENTTARGET || '');
  formData.append('__EVENTARGUMENT', payload.__EVENTARGUMENT || '');
  formData.append('__LASTFOCUS', payload.__LASTFOCUS || '');
  formData.append('__VIEWSTATE', state.viewState);
  formData.append('__VIEWSTATEGENERATOR', state.viewStateGenerator);
  formData.append('__EVENTVALIDATION', state.eventValidation);
  
  // Form fields
  formData.append('ctl00$MainContent$ddlMake', payload.makeId || '0');
  formData.append('ctl00$MainContent$ddlModel', payload.modelId || '0');
  formData.append('ctl00$MainContent$ddlYear', payload.yearId || '0');
  formData.append('ctl00$MainContent$ddlCountry', payload.countryId || '0');
  formData.append('ctl00$MainContent$ddlFuel', payload.fuelTypeId || '0');
  formData.append('ctl00$MainContent$ddlEngine', payload.engineId || '0');
  
  formData.append('__ASYNCPOST', 'true');
  
  if (state.antiXsrfToken) {
    formData.append('__RequestVerificationToken', state.antiXsrfToken);
  }

  try {
    const response = await axiosInstance.post('/', formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Referer': BASE_URL,
        'Cookie': state.cookies.join('; ')
      }
    });

    // Update cookies if new ones were set
    if (response.headers['set-cookie']) {
      state.cookies = response.headers['set-cookie'];
    }

    // Parse the response and update state
    const result = parseResponse(response.data, state);
    sessions.set(sessionId, { ...state, ...result.newState });
    
    return {
      html: result.parsed.html,
      options: extractOptions(result.parsed.html, getSelectorForTarget(payload.__EVENTTARGET)),
      newState: result.newState
    };
  } catch (error) {
    console.error('POST request failed:', error);
    throw error;
  }
}

function getSelectorForTarget(eventTarget) {
  switch (eventTarget) {
    case 'ctl00$MainContent$ddlMake': return '#MainContent_ddlModel option';
    case 'ctl00$MainContent$ddlModel': return '#MainContent_ddlYear option';
    case 'ctl00$MainContent$ddlYear': return '#MainContent_ddlCountry option';
    case 'ctl00$MainContent$ddlCountry': return '#MainContent_ddlFuel option';
    case 'ctl00$MainContent$ddlFuel': return '#MainContent_ddlEngine option';
    default: return '';
  }
}

function parseResponse(responseData, currentState) {
  if (responseData.includes('<html')) {
    // Full page response
    const $ = cheerio.load(responseData);
    return {
      parsed: {
        viewState: $('input#__VIEWSTATE').val() || currentState.viewState,
        viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || currentState.viewStateGenerator,
        eventValidation: $('input#__EVENTVALIDATION').val() || currentState.eventValidation,
        html: responseData
      },
      newState: {
        viewState: $('input#__VIEWSTATE').val() || currentState.viewState,
        viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || currentState.viewStateGenerator,
        eventValidation: $('input#__EVENTVALIDATION').val() || currentState.eventValidation
      }
    };
  } else {
    // AJAX response (pipe-delimited)
    const parts = responseData.split('|');
    const result = {
      viewState: currentState.viewState,
      viewStateGenerator: currentState.viewStateGenerator,
      eventValidation: currentState.eventValidation,
      html: null
    };
    
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '__VIEWSTATE' && parts[i+1]) {
        result.viewState = parts[i+1];
        i++;
      } else if (parts[i] === '__VIEWSTATEGENERATOR' && parts[i+1]) {
        result.viewStateGenerator = parts[i+1];
        i++;
      } else if (parts[i] === '__EVENTVALIDATION' && parts[i+1]) {
        result.eventValidation = parts[i+1];
        i++;
      } else if (parts[i].includes('ddlPanel') && parts[i+1]) {
        result.html = parts[i+1];
        i++;
      }
    }

    return {
      parsed: result,
      newState: {
        viewState: result.viewState,
        viewStateGenerator: result.viewStateGenerator,
        eventValidation: result.eventValidation
      }
    };
  }
}

function extractOptions(html, selector) {
  if (!html || !selector) return [];
  const $ = cheerio.load(html);
  return $(selector).map((i, el) => ({
    value: $(el).attr('value'),
    text: $(el).text().trim(),
    disabled: $(el).is(':disabled') || $(el).attr('value') === '0'
  })).get().filter(opt => !opt.disabled);
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// API Endpoints

// Initialize a new scraping session
app.post('/api/session/init', async (req, res) => {
  try {
    const { sessionId, state } = await initializeSession();
    const $ = cheerio.load(state.lastResponse);
    
    const makes = $('#MainContent_ddlMake option').map((i, el) => ({
      value: $(el).attr('value'),
      text: $(el).text().trim()
    })).get().filter(opt => opt.value !== '0');

    res.json({
      success: true,
      sessionId,
      makes,
      tokens: {
        viewState: state.viewState,
        viewStateGenerator: state.viewStateGenerator,
        eventValidation: state.eventValidation
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to initialize session',
      details: error.message
    });
  }
});

// Get dependent options
app.post('/api/options', async (req, res) => {
  try {
    const { sessionId, eventTarget, makeId, modelId, yearId, countryId, fuelTypeId } = req.body;
    
    if (!sessionId) throw new Error('Session ID is required');
    if (!eventTarget) throw new Error('Event target is required');

    const payload = {
      __EVENTTARGET: eventTarget,
      makeId,
      modelId,
      yearId,
      countryId,
      fuelTypeId
    };

    const { options, newState } = await postFormData(sessionId, payload);

    res.json({
      success: true,
      options,
      tokens: {
        viewState: newState.viewState,
        viewStateGenerator: newState.viewStateGenerator,
        eventValidation: newState.eventValidation
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to fetch options',
      details: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});