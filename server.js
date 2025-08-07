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

// Helper to parse initial state
async function getInitialState() {
  const response = await axiosInstance.get('/');
  const $ = cheerio.load(response.data);
  
  return {
    viewState: $('input#__VIEWSTATE').val(),
    viewStateGenerator: $('input#__VIEWSTATEGENERATOR').val() || 'CA0B0334',
    eventValidation: $('input#__EVENTVALIDATION').val(),
    antiXsrfToken: $('input[name="__RequestVerificationToken"]').val() || '',
    makes: $('#MainContent_ddlMake option').map((i, el) => ({
      value: $(el).attr('value'),
      text: $(el).text().trim()
    })).get().filter(opt => opt.value !== '0')
  };
}

// Helper to make ASP.NET post requests
async function postFormData(payload, currentState) {
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
        'Referer': BASE_URL
      }
    });

    return parseResponse(response.data, currentState);
  } catch (error) {
    console.error('POST request failed:', error.message);
    throw error;
  }
}

// Parse the ASP.NET AJAX response
function parseResponse(responseData, currentState) {
  const parts = responseData.split('|');
  const result = {
    viewState: currentState.viewState,
    viewStateGenerator: currentState.viewStateGenerator,
    eventValidation: currentState.eventValidation,
    html: null
  };
  
  // Parse response parts
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
      antiXsrfToken: currentState.antiXsrfToken
    }
  };
}

// Extract options from HTML
function extractOptions(html, selector) {
  const $ = cheerio.load(html);
  return $(selector).map((i, el) => ({
    value: $(el).attr('value'),
    text: $(el).text().trim()
  })).get().filter(opt => opt.value !== '0');
}

// API Endpoints

// Get initial state and makes
app.get('/api/init', async (req, res) => {
  try {
    const state = await getInitialState();
    res.json({
      success: true,
      data: {
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
      error: 'Initialization failed',
      details: error.message
    });
  }
});

// Get models for a make
app.post('/api/models', async (req, res) => {
  try {
    const { makeId, tokens } = req.body;
    if (!makeId) throw new Error('Make ID is required');
    if (!tokens) throw new Error('Tokens are required');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlMake',
      makeId: makeId
    }, tokens);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const models = extractOptions(parsed.html, '#MainContent_ddlModel option');

    res.json({
      success: true,
      data: {
        models,
        tokens: newState
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
    const { makeId, modelId, tokens } = req.body;
    if (!makeId || !modelId) throw new Error('Make and Model IDs are required');
    if (!tokens) throw new Error('Tokens are required');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlModel',
      makeId: makeId,
      modelId: modelId
    }, tokens);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const years = extractOptions(parsed.html, '#MainContent_ddlYear option');

    res.json({
      success: true,
      data: {
        years,
        tokens: newState
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
    const { makeId, modelId, yearId, tokens } = req.body;
    if (!makeId || !modelId || !yearId) throw new Error('Make, Model and Year IDs are required');
    if (!tokens) throw new Error('Tokens are required');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlYear',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId
    }, tokens);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const countries = extractOptions(parsed.html, '#MainContent_ddlCountry option');

    res.json({
      success: true,
      data: {
        countries,
        tokens: newState
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
    const { makeId, modelId, yearId, countryId, tokens } = req.body;
    if (!makeId || !modelId || !yearId || !countryId) throw new Error('All previous selections are required');
    if (!tokens) throw new Error('Tokens are required');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlCountry',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId,
      countryId: countryId
    }, tokens);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const fuelTypes = extractOptions(parsed.html, '#MainContent_ddlFuel option');

    res.json({
      success: true,
      data: {
        fuelTypes,
        tokens: newState
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
    const { makeId, modelId, yearId, countryId, fuelTypeId, tokens } = req.body;
    if (!makeId || !modelId || !yearId || !countryId || !fuelTypeId) {
      throw new Error('All previous selections are required');
    }
    if (!tokens) throw new Error('Tokens are required');

    const { parsed, newState } = await postFormData({
      __EVENTTARGET: 'ctl00$MainContent$ddlFuel',
      makeId: makeId,
      modelId: modelId,
      yearId: yearId,
      countryId: countryId,
      fuelTypeId: fuelTypeId
    }, tokens);

    if (!parsed.html) {
      throw new Error('No HTML content in response');
    }

    const engines = extractOptions(parsed.html, '#MainContent_ddlEngine option');

    res.json({
      success: true,
      data: {
        engines,
        tokens: newState
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});