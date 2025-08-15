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
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Origin': BASE_URL,
    'Referer': BASE_URL,
    'X-Requested-With': 'XMLHttpRequest',
    'X-MicrosoftAjax': 'Delta=true'
  },
  withCredentials: true
});

// Cache for storing session data
const sessionCache = new Map();

// Helper to parse initial state
async function getInitialState(sessionId) {
  try {
    const response = await axiosInstance.get('/');
    const $ = cheerio.load(response.data);
    
    const state = {
      viewState: $('input#__VIEWSTATE').val(),
      viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || 'CA0B0334',
      eventValidation: $('input#__EVENTVALIDATION').val(),
      antiXsrfToken: $('input[name="__RequestVerificationToken"]').val() || '',
      makes: $('#MainContent_ddlMake option').map((i, el) => ({
        value: $(el).attr('value'),
        text: $(el).text().trim()
      })).get().filter(opt => opt.value !== '0'),
      cookies: response.headers['set-cookie'] || []
    };

    // Store the initial state in cache
    if (sessionId) {
      sessionCache.set(sessionId, state);
    }

    return state;
  } catch (error) {
    console.error('Error getting initial state:', error);
    throw error;
  }
}

// Helper to make ASP.NET post requests
async function postFormData(payload, currentState, sessionId) {
  const formData = new URLSearchParams();
  
  // Add all required fields in EXACT order seen in network trace
  formData.append('ctl00$ctl08', `ctl00$MainContent$ddlPanel|${payload.__EVENTTARGET}`);
  formData.append('__EVENTTARGET', payload.__EVENTTARGET);
  formData.append('__EVENTARGUMENT', '');
  formData.append('__LASTFOCUS', '');
  formData.append('__VIEWSTATE', currentState.viewState);
  formData.append('__VIEWSTATEGENERATOR', currentState.viewStateGenerator);
  formData.append('__EVENTVALIDATION', currentState.eventValidation);
  
  // Add form fields
  formData.append('ctl00$MainContent$ddlMake', payload.makeId || '0');
  formData.append('ctl00$MainContent$ddlModel', payload.modelId || '0');
  formData.append('ctl00$MainContent$ddlYear', payload.yearId || '0');
  formData.append('ctl00$MainContent$ddlCountry', payload.countryId || '0');
  formData.append('ctl00$MainContent$ddlFuel', payload.fuelTypeId || '0');
  formData.append('ctl00$MainContent$ddlEngine', payload.engineId || '0');
  
  formData.append('__ASYNCPOST', 'true');
  
  // Add anti-CSRF token if available
  if (currentState.antiXsrfToken) {
    formData.append('__RequestVerificationToken', currentState.antiXsrfToken);
  }

  // Add delay to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    const response = await axiosInstance.post('/', formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Referer': BASE_URL,
        'Cookie': currentState.cookies ? currentState.cookies.join('; ') : ''
      }
    });

    const result = parseResponse(response.data, currentState);
    
    // Update session cache
    if (sessionId) {
      sessionCache.set(sessionId, {
        ...currentState,
        viewState: result.parsed.viewState,
        eventValidation: result.parsed.eventValidation,
        cookies: response.headers['set-cookie'] || currentState.cookies
      });
    }

    return result;
  } catch (error) {
    console.error('POST request failed:', error.message);
    throw error;
  }
}

// Parse the ASP.NET AJAX response
function parseResponse(responseData, currentState) {
  // Handle both full page reloads and AJAX responses
  if (responseData.includes('<html')) {
    // Full page response - parse with cheerio
    const $ = cheerio.load(responseData);
    return {
      data: responseData,
      parsed: {
        viewState: $('input#__VIEWSTATE').val() || currentState.viewState,
        viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || currentState.viewStateGenerator,
        eventValidation: $('input#__EVENTVALIDATION').val() || currentState.eventValidation,
        html: responseData
      },
      newState: {
        viewState: $('input#__VIEWSTATE').val() || currentState.viewState,
        viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || currentState.viewStateGenerator,
        eventValidation: $('input#__EVENTVALIDATION').val() || currentState.eventValidation,
        antiXsrfToken: currentState.antiXsrfToken,
        cookies: currentState.cookies
      }
    };
  } else {
    // AJAX response - parse the pipe-delimited format
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
      } else if (parts[i].includes('ddlPanel') && parts[i+1] && 
                (parts[i+1].includes('select') || parts[i+1].includes('option'))) {
        result.html = parts[i+1];
        i++;
      }
    }

    return {
      data: responseData,
      parsed: result,
      newState: {
        viewState: result.viewState,
        viewStateGenerator: result.viewStateGenerator,
        eventValidation: result.eventValidation,
        antiXsrfToken: currentState.antiXsrfToken,
        cookies: currentState.cookies
      }
    };
  }
}

// Extract options from HTML
function extractOptions(html, selector) {
  const $ = cheerio.load(html);
  const options = $(selector).map((i, el) => ({
    value: $(el).attr('value'),
    text: $(el).text().trim(),
    disabled: $(el).is(':disabled')
  })).get();
  
  return {
    all: options,
    enabled: options.filter(opt => !opt.disabled && opt.value !== '0'),
    disabled: options.filter(opt => opt.disabled || opt.value === '0')
  };
}

// Generate a session ID
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// API Endpoints

// Initialize a new scraping session
app.post('/api/session/init', async (req, res) => {
  try {
    const sessionId = generateSessionId();
    const state = await getInitialState(sessionId);
    
    res.json({
      success: true,
      data: {
        sessionId,
        makes: state.makes,
        tokens: {
          viewState: state.viewState,
          viewStateGenerator: state.viewStateGenerator,
          eventValidation: state.eventValidation,
          antiXsrfToken: state.antiXsrfToken
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Session initialization failed',
      details: error.message
    });
  }
});

// Get models for a make
app.post('/api/models', async (req, res) => {
  try {
    const { makeId, sessionId } = req.body;
    if (!makeId) throw new Error('Make ID is required');
    if (!sessionId) throw new Error('Session ID is required');

    const currentState = sessionCache.get(sessionId);
    if (!currentState) throw new Error('Invalid session ID');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlMake',
      makeId: makeId
    }, currentState, sessionId);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const models = extractOptions(parsed.html, '#MainContent_ddlModel option');

    res.json({
      success: true,
      data: {
        models: models.enabled,
        tokens: {
          viewState: newState.viewState,
          viewStateGenerator: newState.viewStateGenerator,
          eventValidation: newState.eventValidation,
          antiXsrfToken: newState.antiXsrfToken
        },
        sessionId
      }
    });
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch models',
      details: error.message
    });
  }
});

// Get years for a model
app.post('/api/years', async (req, res) => {
  try {
    const { makeId, modelId, sessionId } = req.body;
    if (!makeId || !modelId) throw new Error('Make and Model IDs are required');
    if (!sessionId) throw new Error('Session ID is required');

    const currentState = sessionCache.get(sessionId);
    if (!currentState) throw new Error('Invalid session ID');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlModel',
      makeId: makeId,
      modelId: modelId
    }, currentState, sessionId);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const years = extractOptions(parsed.html, '#MainContent_ddlYear option');

    res.json({
      success: true,
      data: {
        years: years.enabled,
        tokens: {
          viewState: newState.viewState,
          viewStateGenerator: newState.viewStateGenerator,
          eventValidation: newState.eventValidation,
          antiXsrfToken: newState.antiXsrfToken
        },
        sessionId
      }
    });
  } catch (error) {
    console.error('Error fetching years:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch years',
      details: error.message
    });
  }
});

// Get countries for a year
app.post('/api/countries', async (req, res) => {
  try {
    const { makeId, modelId, yearId, sessionId } = req.body;
    if (!makeId || !modelId || !yearId) throw new Error('Make, Model and Year IDs are required');
    if (!sessionId) throw new Error('Session ID is required');

    const currentState = sessionCache.get(sessionId);
    if (!currentState) throw new Error('Invalid session ID');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlYear',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId
    }, currentState, sessionId);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const countries = extractOptions(parsed.html, '#MainContent_ddlCountry option');

    res.json({
      success: true,
      data: {
        countries: countries.enabled,
        tokens: {
          viewState: newState.viewState,
          viewStateGenerator: newState.viewStateGenerator,
          eventValidation: newState.eventValidation,
          antiXsrfToken: newState.antiXsrfToken
        },
        sessionId
      }
    });
  } catch (error) {
    console.error('Error fetching countries:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch countries',
      details: error.message
    });
  }
});

// Get fuel types for a country
app.post('/api/fuel-types', async (req, res) => {
  try {
    const { makeId, modelId, yearId, countryId, sessionId } = req.body;
    if (!makeId || !modelId || !yearId || !countryId) throw new Error('All previous selections are required');
    if (!sessionId) throw new Error('Session ID is required');

    const currentState = sessionCache.get(sessionId);
    if (!currentState) throw new Error('Invalid session ID');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlCountry',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId,
      countryId: countryId
    }, currentState, sessionId);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const fuelTypes = extractOptions(parsed.html, '#MainContent_ddlFuel option');

    res.json({
      success: true,
      data: {
        fuelTypes: fuelTypes.enabled,
        tokens: {
          viewState: newState.viewState,
          viewStateGenerator: newState.viewStateGenerator,
          eventValidation: newState.eventValidation,
          antiXsrfToken: newState.antiXsrfToken
        },
        sessionId
      }
    });
  } catch (error) {
    console.error('Error fetching fuel types:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch fuel types',
      details: error.message
    });
  }
});

// Get engine capacities for a fuel type
app.post('/api/engines', async (req, res) => {
  try {
    const { makeId, modelId, yearId, countryId, fuelTypeId, sessionId } = req.body;
    if (!makeId || !modelId || !yearId || !countryId || !fuelTypeId) {
      throw new Error('All previous selections are required');
    }
    if (!sessionId) throw new Error('Session ID is required');

    const currentState = sessionCache.get(sessionId);
    if (!currentState) throw new Error('Invalid session ID');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlFuel',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId,
      countryId: countryId,
      fuelTypeId: fuelTypeId
    }, currentState, sessionId);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const engines = extractOptions(parsed.html, '#MainContent_ddlEngine option');

    res.json({
      success: true,
      data: {
        engines: engines.enabled,
        tokens: {
          viewState: newState.viewState,
          viewStateGenerator: newState.viewStateGenerator,
          eventValidation: newState.eventValidation,
          antiXsrfToken: newState.antiXsrfToken
        },
        sessionId
      }
    });
  } catch (error) {
    console.error('Error fetching engines:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch engines',
      details: error.message
    });
  }
});

// Get all options in one flow (for testing)
app.post('/api/full-flow', async (req, res) => {
  try {
    const sessionId = generateSessionId();
    let state = await getInitialState(sessionId);
    
    // Get makes (already have them from init)
    const makes = state.makes;
    
    // Select first make and get models
    const makeId = makes[0].value;
    let models = [];
    
    const modelResponse = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlMake',
      makeId: makeId
    }, state, sessionId);
    
    state = modelResponse.newState;
    models = extractOptions(modelResponse.parsed.html, '#MainContent_ddlModel option').enabled;
    
    if (models.length === 0) {
      return res.json({
        success: true,
        data: {
          makes,
          models: [],
          message: 'No models available for the first make'
        }
      });
    }
    
    // Select first model and get years
    const modelId = models[0].value;
    let years = [];
    
    const yearResponse = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlModel',
      makeId: makeId,
      modelId: modelId
    }, state, sessionId);
    
    state = yearResponse.newState;
    years = extractOptions(yearResponse.parsed.html, '#MainContent_ddlYear option').enabled;
    
    if (years.length === 0) {
      return res.json({
        success: true,
        data: {
          makes,
          models,
          years: [],
          message: 'No years available for the selected model'
        }
      });
    }
    
    // Select first year and get countries
    const yearId = years[0].value;
    let countries = [];
    
    const countryResponse = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlYear',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId
    }, state, sessionId);
    
    state = countryResponse.newState;
    countries = extractOptions(countryResponse.parsed.html, '#MainContent_ddlCountry option').enabled;
    
    if (countries.length === 0) {
      return res.json({
        success: true,
        data: {
          makes,
          models,
          years,
          countries: [],
          message: 'No countries available for the selected year'
        }
      });
    }
    
    // Select first country and get fuel types
    const countryId = countries[0].value;
    let fuelTypes = [];
    
    const fuelResponse = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlCountry',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId,
      countryId: countryId
    }, state, sessionId);
    
    state = fuelResponse.newState;
    fuelTypes = extractOptions(fuelResponse.parsed.html, '#MainContent_ddlFuel option').enabled;
    
    if (fuelTypes.length === 0) {
      return res.json({
        success: true,
        data: {
          makes,
          models,
          years,
          countries,
          fuelTypes: [],
          message: 'No fuel types available for the selected country'
        }
      });
    }
    
    // Select first fuel type and get engines
    const fuelTypeId = fuelTypes[0].value;
    let engines = [];
    
    const engineResponse = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlFuel',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId,
      countryId: countryId,
      fuelTypeId: fuelTypeId
    }, state, sessionId);
    
    state = engineResponse.newState;
    engines = extractOptions(engineResponse.parsed.html, '#MainContent_ddlEngine option').enabled;
    
    res.json({
      success: true,
      data: {
        makes,
        models,
        years,
        countries,
        fuelTypes,
        engines,
        sessionId
      }
    });
  } catch (error) {
    console.error('Error in full flow:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete full flow',
      details: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});