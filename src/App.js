import React, { useState, useEffect, useRef, useCallback } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import { Container, Row, Col, Card, Table, Navbar, Nav, Button, Alert, Badge, Spinner, Form } from 'react-bootstrap';
import { ArrowUp, ArrowDown, Activity, BarChart2, Eye, Shield, List, AlertTriangle, Search, Filter, Check } from 'lucide-react';

// Simple debounce utility function
const debounce = (func, wait) => {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

// Base URLs for Binance APIs
const REST_BASE_URL = 'https://fapi.binance.com';
const WS_BASE_URL = 'wss://fstream.binance.com/ws';

// Helper function to determine the appropriate number of decimal places based on price
const getDynamicPrecision = (price) => {
  if (price >= 10000) return 2;  // BTC, high-value coins
  if (price >= 100) return 3;    // Mid-range coins
  if (price >= 1) return 4;      // Lower-value coins
  if (price >= 0.01) return 5;   // Very low-value coins
  return 8;                      // Extremely low-value coins
};

// Component to fetch and display data from Binance Futures API
const App = () => {
  const [loading, setLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [allCryptoData, setAllCryptoData] = useState([]); // All available crypto pairs
  const [cryptoData, setCryptoData] = useState([]); // Selected crypto pairs to monitor
  const [exchangeInfo, setExchangeInfo] = useState(null);
  const [error, setError] = useState(null);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [ohlcData, setOhlcData] = useState([]);
  const [orderBookData, setOrderBookData] = useState({ bids: [], asks: [] });
  const [spoofEvents, setSpoofEvents] = useState([]);
  const [lastPrices, setLastPrices] = useState({});
  const [priceChangePercent, setPriceChangePercent] = useState({});
  const [volumes, setVolumes] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCryptos, setSelectedCryptos] = useState([]);
  const [showCryptoSelector, setShowCryptoSelector] = useState(true);
  const [isMonitoring, setIsMonitoring] = useState(false);
  
  // WebSocket connections management
  const websocketRef = useRef(null);
  const combinedStreamRef = useRef(null);
  
  // Spoof detection settings
  const [minOrderSize, setMinOrderSize] = useState(5.0);
  const [timeWindow, setTimeWindow] = useState(3.0);
  const [orderBookSnapshots, setOrderBookSnapshots] = useState({});
  const [priceImpactThreshold, setPriceImpactThreshold] = useState(0.5); // percentage
  const [layeringThreshold, setLayeringThreshold] = useState(5); // number of orders

  // Advanced detection patterns
  const [patternDetection, setPatternDetection] = useState({
    detectLayering: true,
    detectIceberg: true,
    detectMomentum: true,
    detectSpoofing: true
  });
  
  // Fetch exchange information from Binance Futures API
  useEffect(() => {
    const fetchExchangeInfo = async () => {
      try {
        setLoading(true);
        
        // Fetch exchange information
        const response = await fetch(`${REST_BASE_URL}/fapi/v1/exchangeInfo`);
        
        if (!response.ok) {
          throw new Error(`API request failed with status ${response.status}`);
        }
        
        const data = await response.json();
        setExchangeInfo(data);
        
        // Process all available symbols data
        const processedData = data.symbols
          .filter(symbol => symbol.status === 'TRADING' && symbol.contractType === 'PERPETUAL')
          .map((symbol, index) => ({
            id: index + 1,
            name: symbol.baseAsset,
            symbol: symbol.symbol,
            pair: symbol.pair,
            price: 0,
            change: 0,
            volume: '0',
            marketCap: '0',
            spoofEvents: 0,
            layeringEvents: 0,
            icebergEvents: 0,
            momentumEvents: 0,
            totalEvents: 0,
            filters: symbol.filters,
            baseAsset: symbol.baseAsset,
            quoteAsset: symbol.quoteAsset
          }));
        
        setAllCryptoData(processedData);
        setLoading(false);
        setInitialLoading(false);
        
      } catch (err) {
        console.error('Error fetching exchange info:', err);
        setError(`API Error: ${err.message}. Please check your connection and try again.`);
        setLoading(false);
        setInitialLoading(false);
      }
    };

    fetchExchangeInfo();
    
    // Cleanup function
    return () => {
      closeWebSockets();
    };
  }, []);

  // Start monitoring when the user has selected cryptos and clicked Start
  useEffect(() => {
    if (isMonitoring && cryptoData.length > 0) {
      // Initialize price and volume data
      let initialPrices = {};
      let initialVolumes = {};
      
      cryptoData.forEach(crypto => {
        initialPrices[crypto.symbol] = 0;
        initialVolumes[crypto.symbol] = 0;
      });
      
      setLastPrices(initialPrices);
      setVolumes(initialVolumes);
      
      // Fetch initial data for selected symbols
      for (const crypto of cryptoData) {
        fetchKlines(crypto.symbol);
        fetchOrderBook(crypto.symbol);
      }
      
      // Set up WebSocket connections for monitored symbols
      setupWebSockets(cryptoData.map(crypto => crypto.symbol));
      
      // Set default selected symbol if not already set
      if (!selectedSymbol && cryptoData.length > 0) {
        setSelectedSymbol(cryptoData[0].symbol);
      }
    }
  }, [isMonitoring, cryptoData]);

  // Fetch data when selected symbol changes
  useEffect(() => {
    if (selectedSymbol && isMonitoring) {
      // Fetch updated data for the selected symbol
      fetchKlines(selectedSymbol);
      fetchOrderBook(selectedSymbol);
    }
  }, [selectedSymbol]);

  // Optimized filtering that doesn't cause unnecessary re-renders
  // This is memoized and will only recalculate when dependencies change
  const filteredCryptos = React.useMemo(() => {
    return allCryptoData.filter(crypto => 
      crypto.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
      crypto.baseAsset.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [searchTerm, allCryptoData]);

  // Toggle crypto selection
  const toggleCryptoSelection = (symbol) => {
    if (selectedCryptos.includes(symbol)) {
      setSelectedCryptos(selectedCryptos.filter(s => s !== symbol));
    } else {
      if (selectedCryptos.length < 10) {
        setSelectedCryptos([...selectedCryptos, symbol]);
      } else {
        // Alert user they can only select 10
        alert('You can only select up to 10 cryptocurrencies to monitor.');
      }
    }
  };

  // Start monitoring selected cryptos
  const startMonitoring = () => {
    if (selectedCryptos.length === 0) {
      alert('Please select at least one cryptocurrency to monitor.');
      return;
    }
    
    // Set the selected cryptos as the active cryptoData
    const selectedCryptoData = allCryptoData.filter(crypto => 
      selectedCryptos.includes(crypto.symbol)
    );
    
    setCryptoData(selectedCryptoData);
    setIsMonitoring(true);
    setShowCryptoSelector(false);
    setSelectedSymbol(selectedCryptos[0]);
  };

  // Reset selection and stop monitoring
  const resetSelection = () => {
    // Close all websocket connections
    closeWebSockets();
    
    // Reset state
    setIsMonitoring(false);
    setSelectedCryptos([]);
    setCryptoData([]);
    setSelectedSymbol('');
    setSpoofEvents([]);
    setLastPrices({});
    setPriceChangePercent({});
    setVolumes({});
    setOrderBookData({ bids: [], asks: [] });
    setOhlcData([]);
    setShowCryptoSelector(true);
  };

  // Setup combined WebSocket for multiple symbols
  const setupWebSockets = (symbols) => {
    // Close existing connections
    closeWebSockets();
    
    if (symbols.length === 0) return;
    
    try {
      // Create individual connections for each symbol rather than one large combined stream
      symbols.forEach(symbol => {
        const lowercaseSymbol = symbol.toLowerCase();
        
        // Connect to kline stream
        const klineWs = new WebSocket(`${WS_BASE_URL}/${lowercaseSymbol}@kline_1h`);
        
        klineWs.onopen = () => {
          console.log(`Kline WebSocket connected for ${symbol}`);
        };
        
        klineWs.onmessage = (event) => {
          const data = JSON.parse(event.data);
          processKlineUpdate(symbol, data);
        };
        
        klineWs.onerror = (error) => {
          console.error(`Kline WebSocket error for ${symbol}:`, error);
        };
        
        // Connect to depth stream
        const depthWs = new WebSocket(`${WS_BASE_URL}/${lowercaseSymbol}@depth@100ms`);
        
        depthWs.onopen = () => {
          console.log(`Depth WebSocket connected for ${symbol}`);
        };
        
        depthWs.onmessage = (event) => {
          const data = JSON.parse(event.data);
          processOrderBookUpdate(symbol, data);
        };
        
        depthWs.onerror = (error) => {
          console.error(`Depth WebSocket error for ${symbol}:`, error);
        };
        
        // Connect to ticker stream with reduced update frequency (1000ms instead of default)
        const tickerWs = new WebSocket(`${WS_BASE_URL}/${lowercaseSymbol}@ticker@1000ms`);
        
        tickerWs.onopen = () => {
          console.log(`Ticker WebSocket connected for ${symbol}`);
        };
        
        tickerWs.onmessage = (event) => {
          const data = JSON.parse(event.data);
          processTickerUpdate(symbol, data);
        };
        
        tickerWs.onerror = (error) => {
          console.error(`Ticker WebSocket error for ${symbol}:`, error);
        };
        
        // Store websocket references
        if (!websocketRef.current) {
          websocketRef.current = {};
        }
        
        if (!websocketRef.current[symbol]) {
          websocketRef.current[symbol] = {};
        }
        
        websocketRef.current[symbol].kline = klineWs;
        websocketRef.current[symbol].depth = depthWs;
        websocketRef.current[symbol].ticker = tickerWs;
      });
      
      console.log(`WebSocket connections established for ${symbols.length} symbols`);
      
    } catch (err) {
      console.error('Error setting up WebSocket connections:', err);
      setError('Failed to establish WebSocket connections. Please refresh the page.');
    }
  };

  // Close WebSocket connections
  const closeWebSockets = () => {
    if (combinedStreamRef.current) {
      combinedStreamRef.current.close();
      combinedStreamRef.current = null;
    }
    
    if (websocketRef.current) {
      // Close all individual websocket connections
      Object.keys(websocketRef.current).forEach(symbol => {
        const connections = websocketRef.current[symbol];
        
        if (connections.kline) {
          connections.kline.close();
        }
        
        if (connections.depth) {
          connections.depth.close();
        }
        
        if (connections.ticker) {
          connections.ticker.close();
        }
      });
      
      websocketRef.current = null;
    }
  };

  // Fetch Kline (candlestick) data for a symbol
  const fetchKlines = async (symbol) => {
    try {
      const response = await fetch(
        `${REST_BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=24`
      );
      
      if (!response.ok) {
        throw new Error(`Failed to fetch klines: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Format data for visualization
      const formattedData = data.map(candle => [
        parseInt(candle[0]), // timestamp
        parseFloat(candle[1]), // open
        parseFloat(candle[2]), // high
        parseFloat(candle[3]), // low
        parseFloat(candle[4])  // close
      ]);
      
      if (symbol === selectedSymbol) {
        setOhlcData(formattedData);
      }
      
      // Update last price for this symbol
      if (formattedData.length > 0) {
        const lastCandle = formattedData[formattedData.length - 1];
        const prevCandle = formattedData[formattedData.length - 2];
        
        setLastPrices(prev => ({
          ...prev,
          [symbol]: lastCandle[4]
        }));
        
        if (prevCandle) {
          const change = ((lastCandle[4] - prevCandle[4]) / prevCandle[4]) * 100;
          setPriceChangePercent(prev => ({
            ...prev,
            [symbol]: change
          }));
        }
      }
    } catch (error) {
      console.error(`Error fetching klines for ${symbol}:`, error);
    }
  };

  // Fetch order book data for a symbol
  const fetchOrderBook = async (symbol) => {
    try {
      const response = await fetch(
        `${REST_BASE_URL}/fapi/v1/depth?symbol=${symbol}&limit=100`
      );
      
      if (!response.ok) {
        throw new Error(`Failed to fetch order book: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Format data
      const formattedBids = data.bids.map(bid => [
        parseFloat(bid[0]), // price
        parseFloat(bid[1])  // quantity
      ]);
      
      const formattedAsks = data.asks.map(ask => [
        parseFloat(ask[0]), // price
        parseFloat(ask[1])  // quantity
      ]);
      
      // Store order book snapshot for this symbol
      setOrderBookSnapshots(prev => ({
        ...prev,
        [symbol]: {
          bids: formattedBids,
          asks: formattedAsks,
          lastUpdateId: data.lastUpdateId,
          timestamp: Date.now()
        }
      }));
      
      // Update main order book if this is the selected symbol
      if (symbol === selectedSymbol) {
        setOrderBookData({
          bids: formattedBids,
          asks: formattedAsks,
          lastUpdateId: data.lastUpdateId
        });
      }
    } catch (error) {
      console.error(`Error fetching order book for ${symbol}:`, error);
    }
  };

  // Process kline (candlestick) updates
  const processKlineUpdate = (symbol, data) => {
    if (!data || !data.k) return;
    
    const { t, o, h, l, c } = data.k; // time, open, high, low, close
    
    // Create candlestick data
    const candlestick = [
      parseInt(t), // timestamp
      parseFloat(o), // open
      parseFloat(h), // high
      parseFloat(l), // low
      parseFloat(c)  // close
    ];
    
    // Update last price for this symbol
    setLastPrices(prev => ({
      ...prev,
      [symbol]: parseFloat(c)
    }));
    
    // Update candlestick data if this is the selected symbol
    if (symbol === selectedSymbol) {
      setOhlcData(prevData => {
        if (prevData.length === 0) {
          return [candlestick];
        }
        
        const lastCandle = prevData[prevData.length - 1];
        
        if (lastCandle[0] === candlestick[0]) {
          // Replace last candle with updated data
          return [...prevData.slice(0, -1), candlestick];
        } else {
          // Add new candle
          const newData = [...prevData, candlestick];
          // Keep only the last 24 candles
          return newData.slice(-24);
        }
      });
    }
  };

  // Process order book updates with multiple spoofing detection algorithms
  const processOrderBookUpdate = (symbol, data) => {
    if (!data || (!data.b && !data.asks) || (!data.a && !data.bids)) {
      // Handle both formats - the direct WebSocket format and combined stream format
      return;
    }
    
    const now = Date.now();
    
    // Get bid and ask data accounting for different message formats
    const bidData = data.b || data.bids || [];
    const askData = data.a || data.asks || [];
    
    // Get current order book snapshot for this symbol
    const currentSnapshot = orderBookSnapshots[symbol] || { bids: [], asks: [], timestamp: 0 };
    const updatedBids = [...currentSnapshot.bids];
    const updatedAsks = [...currentSnapshot.asks];
    
    // Keep track of significant changes for pattern detection
    let significantChanges = {
      largeOrdersAdded: [],
      largeOrdersRemoved: [],
      multipleOrdersAtSamePrice: false,
      layeredOrders: false,
      priceImpactDetected: false
    };
    
    // Process bid updates
    bidData.forEach(([priceStr, qtyStr]) => {
      const price = parseFloat(priceStr);
      const quantity = parseFloat(qtyStr);
      
      const bidIndex = updatedBids.findIndex(bid => bid[0] === price);
      
      if (quantity === 0) {
        // Order was removed
        if (bidIndex !== -1) {
          const removedQty = updatedBids[bidIndex][1];
          if (removedQty >= minOrderSize) {
            significantChanges.largeOrdersRemoved.push({
              type: 'bid',
              price,
              quantity: removedQty,
              timestamp: now
            });
          }
          updatedBids.splice(bidIndex, 1);
        }
      } else {
        // Order was added or updated
        if (bidIndex !== -1) {
          const oldQty = updatedBids[bidIndex][1];
          updatedBids[bidIndex] = [price, quantity];
          
          // Check for significant increase
          if (quantity >= minOrderSize && quantity > oldQty * 1.5) {
            significantChanges.largeOrdersAdded.push({
              type: 'bid',
              price,
              quantity,
              timestamp: now
            });
          }
        } else {
          updatedBids.push([price, quantity]);
          if (quantity >= minOrderSize) {
            significantChanges.largeOrdersAdded.push({
              type: 'bid',
              price,
              quantity,
              timestamp: now
            });
          }
        }
      }
    });
    
    // Process ask updates
    askData.forEach(([priceStr, qtyStr]) => {
      const price = parseFloat(priceStr);
      const quantity = parseFloat(qtyStr);
      
      const askIndex = updatedAsks.findIndex(ask => ask[0] === price);
      
      if (quantity === 0) {
        // Order was removed
        if (askIndex !== -1) {
          const removedQty = updatedAsks[askIndex][1];
          if (removedQty >= minOrderSize) {
            significantChanges.largeOrdersRemoved.push({
              type: 'ask',
              price,
              quantity: removedQty,
              timestamp: now
            });
          }
          updatedAsks.splice(askIndex, 1);
        }
      } else {
        // Order was added or updated
        if (askIndex !== -1) {
          const oldQty = updatedAsks[askIndex][1];
          updatedAsks[askIndex] = [price, quantity];
          
          // Check for significant increase
          if (quantity >= minOrderSize && quantity > oldQty * 1.5) {
            significantChanges.largeOrdersAdded.push({
              type: 'ask',
              price,
              quantity,
              timestamp: now
            });
          }
        } else {
          updatedAsks.push([price, quantity]);
          if (quantity >= minOrderSize) {
            significantChanges.largeOrdersAdded.push({
              type: 'ask',
              price,
              quantity,
              timestamp: now
            });
          }
        }
      }
    });
    
    // Sort bids (descending) and asks (ascending)
    updatedBids.sort((a, b) => b[0] - a[0]);
    updatedAsks.sort((a, b) => a[0] - b[0]);
    
    // Update order book snapshot
    setOrderBookSnapshots(prev => ({
      ...prev,
      [symbol]: {
        bids: updatedBids.slice(0, 100),
        asks: updatedAsks.slice(0, 100),
        lastUpdateId: data.u || data.lastUpdateId || (prev[symbol]?.lastUpdateId || 0),
        timestamp: now
      }
    }));
    
    // Update main order book if this is the selected symbol
    if (symbol === selectedSymbol) {
      setOrderBookData({
        bids: updatedBids.slice(0, 100),
        asks: updatedAsks.slice(0, 100),
        lastUpdateId: data.u || data.lastUpdateId || orderBookData.lastUpdateId
      });
    }
    
    // Run pattern detection algorithms
    if (patternDetection.detectSpoofing) {
      detectSpoofingPatterns(symbol, significantChanges, now, currentSnapshot);
    }
    
    if (patternDetection.detectLayering) {
      detectLayeringPatterns(symbol, updatedBids, updatedAsks, now);
    }
    
    if (patternDetection.detectIceberg) {
      detectIcebergPatterns(symbol, significantChanges, now);
    }
    
    if (patternDetection.detectMomentum) {
      detectMomentumIgnition(symbol, significantChanges, now);
    }
  };

  // Create debounced update functions using useCallback to maintain references
  const debouncedPriceUpdate = useCallback(
    debounce((symbol, newPrice, prevPrice) => {
      // Only update if price change is significant (0.05% or more) or it's the first update
      const changePercent = prevPrice ? Math.abs((newPrice - prevPrice) / prevPrice * 100) : 100;
      if (changePercent >= 0.05 || !prevPrice) {
        setLastPrices(prev => ({
          ...prev,
          [symbol]: newPrice
        }));
      }
    }, 250), // Update at most every 250ms
    []
  );

  // Process ticker updates
  const processTickerUpdate = (symbol, data) => {
    if (!data) return;
    
    // Handle direct ticker format and combined stream format
    const price = data.c || data.close;
    const priceChange = data.p || data.priceChange;
    const volume = data.v || data.volume;
    
    if (!price) return;
    
    const newPrice = parseFloat(price);
    const prevPrice = lastPrices[symbol];
    
    // Use debounced update for price
    debouncedPriceUpdate(symbol, newPrice, prevPrice);
    
    // Update price change percentage - no need to debounce this as it doesn't update as frequently
    setPriceChangePercent(prev => ({
      ...prev,
      [symbol]: parseFloat(priceChange)
    }));
    
    // Update 24h volume - not debounced as it changes slowly
    setVolumes(prev => ({
      ...prev,
      [symbol]: parseFloat(volume)
    }));
    
    // Update crypto data with price and volume
    setCryptoData(prevData => {
      return prevData.map(crypto => {
        if (crypto.symbol === symbol) {
          return {
            ...crypto,
            price: newPrice,
            change: parseFloat(priceChange),
            volume: volume
          };
        }
        return crypto;
      });
    });
  };

  // Algorithm 1: Traditional Spoofing Detection
  const detectSpoofingPatterns = (symbol, changes, now, prevSnapshot) => {
    // Check for large orders that were added and removed quickly
    if (changes.largeOrdersRemoved.length === 0) return;
    
    changes.largeOrdersRemoved.forEach(removedOrder => {
      // Find if this order was added recently
      const matchingOrders = prevSnapshot.bids?.concat(prevSnapshot.asks) || [];
      const timeDiff = (now - prevSnapshot.timestamp) / 1000; // in seconds
      
      if (timeDiff <= timeWindow && removedOrder.quantity >= minOrderSize) {
        // Likely spoofing event
        const newSpoofEvent = {
          id: Date.now() + Math.random(),
          time: new Date().toLocaleTimeString(),
          pair: symbol,
          price: removedOrder.price,
          quantity: removedOrder.quantity,
          type: removedOrder.type === 'bid' ? 'Bid' : 'Ask',
          pattern: 'Classic Spoofing',
          duration: timeDiff.toFixed(1)
        };
        
        // Add to spoof events list
        setSpoofEvents(prev => [newSpoofEvent, ...prev].slice(0, 50));
        
        // Update crypto data with spoof count
        updateEventCount(symbol, 'spoofEvents');
      }
    });
  };

  // Algorithm 2: Layering Detection
  const detectLayeringPatterns = (symbol, bids, asks, now) => {
    // Check for multiple large orders at incrementally worse prices on the same side
    
    // Define price increment for checking layers
    const getTickSize = (price) => {
      if (price >= 1000) return 0.1;
      if (price >= 100) return 0.01;
      return 0.001;
    };
    
    // Check bid side layering
    let bidLayers = 0;
    let bidLayerValue = 0;
    
    // Get current price
    const lastPrice = lastPrices[symbol] || 0;
    if (!lastPrice) return;
    
    const tickSize = getTickSize(lastPrice);
    let prevLayerPrice = 0;
    
    // Analyze top bids for layering pattern
    for (let i = 0; i < bids.length && i < 10; i++) {
      const [price, quantity] = bids[i];
      
      if (quantity >= minOrderSize) {
        // Check if this is a new layer with specific price distance
        if (prevLayerPrice === 0 || (prevLayerPrice - price) >= tickSize * 5) {
          bidLayers++;
          bidLayerValue += price * quantity;
          prevLayerPrice = price;
        }
      }
    }
    
    // Check ask side layering
    let askLayers = 0;
    let askLayerValue = 0;
    prevLayerPrice = 0;
    
    // Analyze top asks for layering pattern
    for (let i = 0; i < asks.length && i < 10; i++) {
      const [price, quantity] = asks[i];
      
      if (quantity >= minOrderSize) {
        // Check if this is a new layer with specific price distance
        if (prevLayerPrice === 0 || (price - prevLayerPrice) >= tickSize * 5) {
          askLayers++;
          askLayerValue += price * quantity;
          prevLayerPrice = price;
        }
      }
    }
    
    // If multiple layers detected on either side, create layering event
    if (bidLayers >= layeringThreshold || askLayers >= layeringThreshold) {
      const layerSide = bidLayers > askLayers ? 'Bid' : 'Ask';
      const layerCount = bidLayers > askLayers ? bidLayers : askLayers;
      const layerValue = bidLayers > askLayers ? bidLayerValue : askLayerValue;
      
      const newLayeringEvent = {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString(),
        pair: symbol,
        price: lastPrice,
        quantity: layerValue.toFixed(2),
        type: layerSide,
        pattern: 'Order Layering',
        layerCount,
        duration: '—'
      };
      
      // Add to spoof events with a unique pattern type
      setSpoofEvents(prev => {
        // Check if we already have a similar layering event for this symbol
        const existingLayeringIndex = prev.findIndex(
          e => e.pair === symbol && e.pattern === 'Order Layering' && e.type === layerSide
        );
        
        if (existingLayeringIndex !== -1) {
          // Update existing event instead of adding a new one
          const updated = [...prev];
          updated[existingLayeringIndex] = newLayeringEvent;
          return updated;
        }
        
        // Add as new event
        return [newLayeringEvent, ...prev].slice(0, 50);
      });
      
      // Update layering event count
      updateEventCount(symbol, 'layeringEvents');
    }
  };

  // Algorithm 3: Iceberg Order Detection
  const detectIcebergPatterns = (symbol, changes, now) => {
    // Look for repeated additions at the same price level after executions
    
    // Check if we have multiple updates at the same price level
    const priceFrequency = {};
    
    changes.largeOrdersAdded.forEach(order => {
      const priceKey = `${order.type}-${order.price.toFixed(2)}`;
      priceFrequency[priceKey] = (priceFrequency[priceKey] || 0) + 1;
    });
    
    // Identify price levels with frequent updates
    Object.entries(priceFrequency).forEach(([priceKey, frequency]) => {
      if (frequency >= 3) { // Threshold for iceberg detection
        const [side, priceStr] = priceKey.split('-');
        const price = parseFloat(priceStr);
        
        const newIcebergEvent = {
          id: Date.now() + Math.random(),
          time: new Date().toLocaleTimeString(),
          pair: symbol,
          price,
          quantity: changes.largeOrdersAdded.filter(o => 
            o.type === side && o.price.toFixed(2) === priceStr
          ).reduce((sum, o) => sum + o.quantity, 0),
          type: side === 'bid' ? 'Bid' : 'Ask',
          pattern: 'Iceberg Order',
          frequency,
          duration: '—'
        };
        
        // Add to spoof events list
        setSpoofEvents(prev => {
          // Check for existing iceberg event for this price
          const existingIcebergIndex = prev.findIndex(
            e => e.pair === symbol && e.pattern === 'Iceberg Order' && 
                 e.price === price && e.type === newIcebergEvent.type
          );
          
          if (existingIcebergIndex !== -1) {
            // Update existing event
            const updated = [...prev];
            updated[existingIcebergIndex] = newIcebergEvent;
            return updated;
          }
          
          return [newIcebergEvent, ...prev].slice(0, 50);
        });
        
        // Update iceberg event count
        updateEventCount(symbol, 'icebergEvents');
      }
    });
  };

  // Algorithm 4: Momentum Ignition Detection
  const detectMomentumIgnition = (symbol, changes, now) => {
    const lastPrice = lastPrices[symbol] || 0;
    if (!lastPrice) return;
    
    // Check for large orders that might be trying to create false momentum
    const largeOrdersOnOneSide = changes.largeOrdersAdded.filter(
      order => order.quantity >= minOrderSize * 2
    );
    
    if (largeOrdersOnOneSide.length === 0) return;
    
    // Calculate potential price impact
    const bidImpact = largeOrdersOnOneSide
      .filter(o => o.type === 'bid')
      .reduce((sum, o) => sum + (o.quantity * o.price), 0);
    
    const askImpact = largeOrdersOnOneSide
      .filter(o => o.type === 'ask')
      .reduce((sum, o) => sum + (o.quantity * o.price), 0);
    
    const totalImpact = bidImpact + askImpact;
    const averagePrice = lastPrice;
    
    // Check if impact exceeds threshold
    const impactPercentage = (totalImpact / (averagePrice * 1000)) * 100;
    
    if (impactPercentage >= priceImpactThreshold) {
      const momentumSide = bidImpact > askImpact ? 'Bid' : 'Ask';
      
      const newMomentumEvent = {
        id: Date.now() + Math.random(),
        time: new Date().toLocaleTimeString(),
        pair: symbol,
        price: lastPrice,
        quantity: totalImpact.toFixed(2),
        type: momentumSide,
        pattern: 'Momentum Ignition',
        impact: `${impactPercentage.toFixed(2)}%`,
        duration: '—'
      };
      
      // Add to spoof events list
      setSpoofEvents(prev => [newMomentumEvent, ...prev].slice(0, 50));
      
      // Update momentum event count
      updateEventCount(symbol, 'momentumEvents');
    }
  };

  // Helper function to update event counts
  const updateEventCount = (symbol, eventType) => {
    setCryptoData(prevData => {
      return prevData.map(crypto => {
        if (crypto.symbol === symbol) {
          return {
            ...crypto,
            [eventType]: crypto[eventType] + 1,
            totalEvents: crypto.totalEvents + 1
          };
        }
        return crypto;
      });
    });
  };

  // Update spoof detection settings
  const handleSpoofSettingsUpdate = (
    newMinSize, 
    newTimeWindow, 
    newImpactThreshold, 
    newLayeringThreshold,
    newPatternSettings
  ) => {
    setMinOrderSize(newMinSize);
    setTimeWindow(newTimeWindow);
    setPriceImpactThreshold(newImpactThreshold);
    setLayeringThreshold(newLayeringThreshold);
    
    if (newPatternSettings) {
      setPatternDetection(newPatternSettings);
    }
  };

  // Crypto Selector Component
  const CryptoSelector = () => {
    // We need to use the same state variable to prevent text from disappearing
    const handleSearchChange = (e) => {
      const value = e.target.value;
      // Update the search term directly - we'll optimize elsewhere
      setSearchTerm(value);
    };

    return (
      <Card className="shadow-sm mb-4">
        <Card.Header className="bg-white d-flex justify-content-between align-items-center">
          <h5 className="mb-0">Select Cryptocurrencies to Monitor (Max 10)</h5>
          <Badge bg="primary" pill>{selectedCryptos.length}/10 selected</Badge>
        </Card.Header>
        <Card.Body>
          <div className="mb-3">
            <Form.Group className="d-flex align-items-center">
              <Search size={18} className="me-2 text-muted" />
              <Form.Control
                type="text"
                placeholder="Search by symbol or name..."
                value={searchTerm}
                onChange={handleSearchChange}
                // This key attribute forces React to preserve the input's focus state
                key="search-input"
              />
            </Form.Group>
          </div>
          
          <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
            <Table hover className="mb-0">
              <thead className="sticky-top bg-white">
                <tr>
                  <th>Select</th>
                  <th>Symbol</th>
                  <th>Base Asset</th>
                  <th>Quote Asset</th>
                </tr>
              </thead>
              <tbody>
                {filteredCryptos.map(crypto => (
                  <tr 
                    key={crypto.symbol}
                    className={selectedCryptos.includes(crypto.symbol) ? 'table-primary' : ''}
                    onClick={() => toggleCryptoSelection(crypto.symbol)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <div className="d-flex align-items-center justify-content-center">
                        {selectedCryptos.includes(crypto.symbol) ? 
                          <Check size={18} className="text-primary" /> : 
                          <div className="border rounded-circle" style={{ width: '18px', height: '18px' }}></div>
                        }
                      </div>
                    </td>
                    <td className="fw-bold">{crypto.symbol}</td>
                    <td>{crypto.baseAsset}</td>
                    <td>{crypto.quoteAsset}</td>
                  </tr>
                ))}
                
                {filteredCryptos.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center py-4">
                      No cryptocurrencies found matching "{searchTerm}"
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
        </Card.Body>
        <Card.Footer className="bg-white">
          <div className="d-flex justify-content-between align-items-center">
            <div>
              <small className="text-muted">
                Showing {filteredCryptos.length} of {allCryptoData.length} cryptocurrencies
              </small>
            </div>
            <div>
              <Button 
                variant="secondary" 
                className="me-2"
                onClick={() => setSelectedCryptos([])}
                disabled={selectedCryptos.length === 0}
              >
                Clear Selection
              </Button>
              <Button 
                variant="primary"
                onClick={startMonitoring}
                disabled={selectedCryptos.length === 0}
              >
                Start Monitoring
              </Button>
            </div>
          </div>
        </Card.Footer>
      </Card>
    );
  };

  if (initialLoading) {
    return (
      <div className="d-flex justify-content-center align-items-center vh-100">
        <Spinner animation="border" variant="primary" />
        <span className="ms-2 fs-4">Loading data from Binance Futures API...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="d-flex justify-content-center align-items-center vh-100">
        <Alert variant="danger">
          <Alert.Heading>Error Loading Data</Alert.Heading>
          <p>{error}</p>
          <p>Please check your connection and try again.</p>
          <Button variant="outline-danger" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </Alert>
      </div>
    );
  }

  return (
    <div className="min-vh-100 d-flex flex-column">
      <Header 
        activeTab={activeTab} 
        setActiveTab={setActiveTab}
        isMonitoring={isMonitoring}
        resetSelection={resetSelection}
      />
      
      <Container fluid className="flex-grow-1 py-4">
        {showCryptoSelector ? (
          <CryptoSelector />
        ) : (
          <>
            {activeTab === 'dashboard' && (
              <Dashboard 
                cryptoData={cryptoData} 
                spoofEvents={spoofEvents} 
                selectedSymbol={selectedSymbol}
                setSelectedSymbol={setSelectedSymbol}
                lastPrices={lastPrices}
                priceChangePercent={priceChangePercent}
                volumes={volumes}
              />
            )}
            
            {activeTab === 'spoof-detector' && (
              <SpoofDetector 
                cryptoData={cryptoData} 
                spoofEvents={spoofEvents}
                selectedSymbol={selectedSymbol}
                setSelectedSymbol={setSelectedSymbol}
                orderBookData={orderBookData}
                minOrderSize={minOrderSize}
                timeWindow={timeWindow}
                priceImpactThreshold={priceImpactThreshold}
                layeringThreshold={layeringThreshold}
                patternDetection={patternDetection}
                onSettingsUpdate={handleSpoofSettingsUpdate}
                lastPrice={lastPrices[selectedSymbol]}
              />
            )}
            
            {activeTab === 'market-data' && (
              <MarketData 
                cryptoData={cryptoData} 
                exchangeInfo={exchangeInfo} 
                selectedSymbol={selectedSymbol}
                setSelectedSymbol={setSelectedSymbol}
                lastPrices={lastPrices}
              />
            )}
          </>
        )}
      </Container>
      
      <Footer />
    </div>
  );
};

// Header component with navigation
const Header = ({ activeTab, setActiveTab, isMonitoring, resetSelection }) => {
  return (
    <Navbar bg="dark" variant="dark" expand="lg" className="px-3">
      <Navbar.Brand href="#" className="d-flex align-items-center">
        <Activity size={24} className="me-2" />
        <span>Crypto Market Monitor</span>
      </Navbar.Brand>
      <Navbar.Toggle aria-controls="basic-navbar-nav" />
      <Navbar.Collapse id="basic-navbar-nav">
        <Nav className="ms-auto">
          {isMonitoring && (
            <>
              <Nav.Link 
                active={activeTab === 'dashboard'} 
                onClick={() => setActiveTab('dashboard')}
                className="d-flex align-items-center"
              >
                <BarChart2 size={18} className="me-1" />
                Dashboard
              </Nav.Link>
              <Nav.Link 
                active={activeTab === 'spoof-detector'} 
                onClick={() => setActiveTab('spoof-detector')}
                className="d-flex align-items-center"
              >
                <Eye size={18} className="me-1" />
                Spoof Detector
              </Nav.Link>
              <Nav.Link 
                active={activeTab === 'market-data'} 
                onClick={() => setActiveTab('market-data')}
                className="d-flex align-items-center"
              >
                <List size={18} className="me-1" />
                Market Data
              </Nav.Link>
            </>
          )}
          {isMonitoring && (
            <Button 
              variant="outline-light" 
              size="sm" 
              className="ms-3 d-flex align-items-center"
              onClick={resetSelection}
            >
              <Filter size={16} className="me-1" />
              Change Selection
            </Button>
          )}
        </Nav>
      </Navbar.Collapse>
    </Navbar>
  );
};

// Dashboard component
const Dashboard = ({ 
  cryptoData, 
  spoofEvents, 
  selectedSymbol, 
  setSelectedSymbol, 
  lastPrices,
  priceChangePercent,
  volumes
}) => {
  // Display top cryptocurrencies by manipulation events
  const topCryptos = [...cryptoData]
    .sort((a, b) => b.totalEvents - a.totalEvents)
    .slice(0, 6);
  
  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h2>Market Overview</h2>
        <Form.Group className="d-flex align-items-center" style={{ width: '300px' }}>
          <Form.Label className="me-2 mb-0">Symbol:</Form.Label>
          <Form.Select 
            value={selectedSymbol} 
            onChange={(e) => setSelectedSymbol(e.target.value)}
          >
            {cryptoData.map(crypto => (
              <option key={crypto.symbol} value={crypto.symbol}>
                {crypto.symbol}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
      </div>
      
      <Alert variant="info" className="d-flex align-items-center">
        <Shield size={24} className="me-2" />
        <div className="flex-grow-1">
          Real-time monitoring of {cryptoData.length} cryptocurrency pairs from Binance Futures.
          Currently tracking <strong>{selectedSymbol}</strong> for market manipulation patterns.
        </div>
        <Badge bg="danger" className="ms-2">
          LIVE
        </Badge>
      </Alert>
      
      <Card className="shadow-sm mb-4">
        <Card.Header className="bg-white">
          <h5 className="mb-0">Price Data</h5>
        </Card.Header>
        <Card.Body>
          <div className="d-flex align-items-center justify-content-center py-5">
            <div className="text-center">
              <h1 className="mb-0">
                ${lastPrices[selectedSymbol] 
                  ? lastPrices[selectedSymbol].toLocaleString(undefined, {
                    minimumFractionDigits: getDynamicPrecision(lastPrices[selectedSymbol]),
                    maximumFractionDigits: getDynamicPrecision(lastPrices[selectedSymbol])
                    })
                  : '—'}
              </h1>
              <h3 className={`mt-2 ${priceChangePercent[selectedSymbol] >= 0 ? 'text-success' : 'text-danger'}`}>
                {priceChangePercent[selectedSymbol] 
                  ? `${priceChangePercent[selectedSymbol] >= 0 ? '+' : ''}${priceChangePercent[selectedSymbol].toFixed(2)}%` 
                  : '—'
                }
              </h3>
              <div className="mt-3 text-muted">
                <p>24h Volume: {volumes[selectedSymbol] 
                  ? parseFloat(volumes[selectedSymbol]).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    }) 
                  : '—'} {selectedSymbol.replace(/USDT$|BUSD$/, '')}</p>
                <p><small>Real-time data from Binance Futures WebSocket</small></p>
              </div>
            </div>
          </div>
        </Card.Body>
      </Card>
      
      <Row className="g-4 mb-4">
        {topCryptos.map(crypto => (
          <Col key={crypto.id} lg={4} md={6}>
            <CryptoCard 
              crypto={crypto} 
              isSelected={crypto.symbol === selectedSymbol}
              onClick={() => setSelectedSymbol(crypto.symbol)}
              lastPrice={lastPrices[crypto.symbol]}
              priceChangePercent={priceChangePercent[crypto.symbol]}
              volume={volumes[crypto.symbol]}
            />
          </Col>
        ))}
      </Row>
      
      <Row>
        <Col lg={8}>
          <Card className="shadow-sm mb-4">
            <Card.Header className="bg-white">
              <h5 className="mb-0">Recent Events</h5>
            </Card.Header>
            <Card.Body className="p-0">
              <Table hover responsive className="mb-0">
                <thead className="bg-light">
                  <tr>
                    <th>Time</th>
                    <th>Symbol</th>
                    <th>Pattern</th>
                    <th>Price</th>
                    <th>Quantity</th>
                    <th>Type</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {spoofEvents.slice(0, 10).map(event => (
                    <tr key={event.id}>
                      <td>{event.time}</td>
                      <td>{event.pair}</td>
                      <td>
                        <Badge bg={
                          event.pattern === 'Classic Spoofing' ? 'warning' :
                          event.pattern === 'Order Layering' ? 'info' :
                          event.pattern === 'Iceberg Order' ? 'secondary' :
                          event.pattern === 'Momentum Ignition' ? 'danger' : 'primary'
                        }>
                          {event.pattern}
                        </Badge>
                      </td>
                      <td>
                        <div className="d-flex align-items-center">
                          <span className="me-1">${typeof event.price === 'number' ? event.price.toLocaleString(undefined, {
                            minimumFractionDigits: getDynamicPrecision(event.price),
                            maximumFractionDigits: getDynamicPrecision(event.price)
                          }) : event.price}</span>
                          <AlertTriangle size={14} className="text-warning" />
                        </div>
                      </td>
                      <td>{event.quantity}</td>
                      <td>
                        <Badge bg={event.type === 'Bid' ? 'success' : 'danger'}>
                          {event.type}
                        </Badge>
                      </td>
                      <td>{event.duration}</td>
                    </tr>
                  ))}
                  
                  {spoofEvents.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center py-4">
                        No market manipulation events detected yet. Watching for activity...
                      </td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Col>
        
        <Col lg={4}>
          <Card className="shadow-sm mb-4">
            <Card.Header className="bg-white">
              <h5 className="mb-0">Detection Stats</h5>
            </Card.Header>
            <Card.Body>
              <div className="d-flex justify-content-between mb-3 p-2 bg-light rounded">
                <span>Total Events Detected:</span>
                <span className="fw-bold text-danger">
                  {cryptoData.reduce((sum, crypto) => sum + crypto.totalEvents, 0)}
                </span>
              </div>
              
              <h6 className="mb-2">Top Pairs by Manipulation Activity:</h6>
              {cryptoData
                .filter(crypto => crypto.totalEvents > 0)
                .sort((a, b) => b.totalEvents - a.totalEvents)
                .slice(0, 5)
                .map(crypto => (
                  <div 
                    key={crypto.symbol} 
                    className="d-flex justify-content-between align-items-center mb-2"
                  >
                    <div 
                      className="cursor-pointer fw-bold" 
                      onClick={() => setSelectedSymbol(crypto.symbol)}
                      style={{ cursor: 'pointer' }}
                    >
                      {crypto.symbol}
                      {crypto.symbol === selectedSymbol && (
                        <Badge bg="primary" className="ms-2" pill>Active</Badge>
                      )}
                    </div>
                    <div>
                      <Badge bg="danger">{crypto.totalEvents}</Badge>
                    </div>
                  </div>
                ))}
              
              {cryptoData.every(crypto => crypto.totalEvents === 0) && (
                <div className="text-center py-3 text-muted">
                  No manipulation activity detected yet. Stay vigilant!
                </div>
              )}
            </Card.Body>
          </Card>
          
          <Card className="shadow-sm">
            <Card.Header className="bg-white">
              <h5 className="mb-0">Event Breakdown</h5>
            </Card.Header>
            <Card.Body>
              <div className="d-flex justify-content-between mb-2">
                <span>Classic Spoofing:</span>
                <span className="fw-bold text-warning">
                  {cryptoData.reduce((sum, crypto) => sum + crypto.spoofEvents, 0)}
                </span>
              </div>
              <div className="d-flex justify-content-between mb-2">
                <span>Order Layering:</span>
                <span className="fw-bold text-info">
                  {cryptoData.reduce((sum, crypto) => sum + crypto.layeringEvents, 0)}
                </span>
              </div>
              <div className="d-flex justify-content-between mb-2">
                <span>Iceberg Orders:</span>
                <span className="fw-bold text-secondary">
                  {cryptoData.reduce((sum, crypto) => sum + crypto.icebergEvents, 0)}
                </span>
              </div>
              <div className="d-flex justify-content-between mb-2">
                <span>Momentum Ignition:</span>
                <span className="fw-bold text-danger">
                  {cryptoData.reduce((sum, crypto) => sum + crypto.momentumEvents, 0)}
                </span>
              </div>
              <hr />
              <div className="d-flex justify-content-between">
                <span>Data Source:</span>
                <span className="fw-bold">
                  Binance Futures
                </span>
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

// Individual crypto card component
const CryptoCard = ({ 
  crypto, 
  isSelected, 
  onClick, 
  lastPrice, 
  priceChangePercent,
  volume
}) => {
  return (
    <Card 
      className={`h-100 shadow-sm ${isSelected ? 'border-primary' : ''}`}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    >
      <Card.Body>
        <div className="d-flex justify-content-between align-items-center mb-2">
          <h5 className="mb-0">{crypto.baseAsset}</h5>
          <Badge bg={isSelected ? "primary" : "light"} text={isSelected ? "white" : "dark"}>
            {crypto.baseAsset}
          </Badge>
        </div>
        
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h3 className="mb-0">
            ${typeof lastPrice === 'number' 
              ? lastPrice.toLocaleString(undefined, {
                  minimumFractionDigits: getDynamicPrecision(lastPrice),
                  maximumFractionDigits: getDynamicPrecision(lastPrice)
                })
              : '—'
            }
          </h3>
          <div className={`d-flex align-items-center ${priceChangePercent >= 0 ? 'text-success' : 'text-danger'}`}>
            {priceChangePercent >= 0 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            <span className="ms-1">{Math.abs(priceChangePercent || 0).toFixed(2)}%</span>
          </div>
        </div>
        
        <div className="row g-0 text-muted">
          <div className="col-6 border-end border-bottom p-2">
            <small className="d-block">Symbol</small>
            <span>{crypto.symbol}</span>
          </div>
          <div className="col-6 border-bottom p-2">
            <small className="d-block">Quote Asset</small>
            <span>{crypto.quoteAsset}</span>
          </div>
          <div className="col-6 border-end p-2">
            <small className="d-block">Events Today</small>
            <span className={crypto.totalEvents > 10 ? 'text-danger' : crypto.totalEvents > 0 ? 'text-warning' : ''}>
              {crypto.totalEvents} events
            </span>
          </div>
          <div className="col-6 p-2">
            <small className="d-block">24h Volume</small>
            <span>{volume ? parseFloat(volume).toLocaleString(undefined, {
              maximumFractionDigits: 2
            }) : '—'}</span>
          </div>
        </div>
      </Card.Body>
    </Card>
  );
};

// Spoof Detector component
const SpoofDetector = ({ 
  cryptoData, 
  spoofEvents, 
  selectedSymbol, 
  setSelectedSymbol, 
  orderBookData,
  minOrderSize,
  timeWindow,
  priceImpactThreshold,
  layeringThreshold,
  patternDetection,
  onSettingsUpdate,
  lastPrice
}) => {
  const [localMinSize, setLocalMinSize] = useState(minOrderSize);
  const [localTimeWindow, setLocalTimeWindow] = useState(timeWindow);
  const [localPriceImpact, setLocalPriceImpact] = useState(priceImpactThreshold);
  const [localLayeringThreshold, setLocalLayeringThreshold] = useState(layeringThreshold);
  const [localPatternSettings, setLocalPatternSettings] = useState(patternDetection);
  
  const handleSubmit = (e) => {
    e.preventDefault();
    onSettingsUpdate(localMinSize, localTimeWindow, localPriceImpact, localLayeringThreshold, localPatternSettings);
  };

  // Display order book as a table
  const renderOrderBook = () => {
    // Get top bids and asks
    const topBids = orderBookData.bids.slice(0, 10);
    const topAsks = orderBookData.asks.slice(0, 10).reverse();
    
    return (
      <div className="d-flex">
        <div className="flex-grow-1 me-2">
          <h6 className="text-center mb-2">Bids</h6>
          <Table size="sm" className="mb-0 text-end">
            <thead className="table-light">
              <tr>
                <th className="text-end">Price</th>
                <th className="text-end">Quantity</th>
                <th className="text-end">Total</th>
              </tr>
            </thead>
            <tbody>
              {topBids.map((bid, index) => (
                <tr key={index} className={bid[1] >= minOrderSize ? 'table-warning' : ''}>
                  <td className="text-success">${bid[0].toLocaleString(undefined, {
                    minimumFractionDigits: getDynamicPrecision(bid[0]),
                    maximumFractionDigits: getDynamicPrecision(bid[0])
                  })}</td>
                  <td>{bid[1].toFixed(4)}</td>
                  <td>${(bid[0] * bid[1]).toFixed(2)}</td>
                </tr>
              ))}
              {topBids.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-center">No bids</td>
                </tr>
              )}
            </tbody>
          </Table>
        </div>
        
        <div className="flex-grow-1 ms-2">
          <h6 className="text-center mb-2">Asks</h6>
          <Table size="sm" className="mb-0 text-end">
            <thead className="table-light">
              <tr>
                <th className="text-end">Price</th>
                <th className="text-end">Quantity</th>
                <th className="text-end">Total</th>
              </tr>
            </thead>
            <tbody>
              {topAsks.map((ask, index) => (
                <tr key={index} className={ask[1] >= minOrderSize ? 'table-warning' : ''}>
                  <td className="text-danger">${ask[0].toLocaleString(undefined, {
                    minimumFractionDigits: getDynamicPrecision(ask[0]),
                    maximumFractionDigits: getDynamicPrecision(ask[0])
                  })}</td>
                  <td>{ask[1].toFixed(4)}</td>
                  <td>${(ask[0] * ask[1]).toFixed(2)}</td>
                </tr>
              ))}
              {topAsks.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-center">No asks</td>
                </tr>
              )}
            </tbody>
          </Table>
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h2>Market Manipulation Detection System</h2>
        <Form.Group className="d-flex align-items-center" style={{ width: '300px' }}>
          <Form.Label className="me-2 mb-0">Symbol:</Form.Label>
          <Form.Select 
            value={selectedSymbol} 
            onChange={(e) => setSelectedSymbol(e.target.value)}
          >
            {cryptoData.map(crypto => (
              <option key={crypto.symbol} value={crypto.symbol}>
                {crypto.symbol}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
      </div>
      
      <Row className="mb-4">
        <Col lg={4}>
          <Card className="shadow-sm h-100">
            <Card.Header className="bg-white">
              <h5 className="mb-0">Detection Settings</h5>
            </Card.Header>
            <Card.Body>
              <Form onSubmit={handleSubmit}>
                <Form.Group className="mb-3">
                  <Form.Label>Minimum Order Size</Form.Label>
                  <Form.Control 
                    type="number" 
                    step="0.1"
                    value={localMinSize}
                    onChange={(e) => setLocalMinSize(parseFloat(e.target.value))}
                  />
                  <Form.Text className="text-muted">
                    Orders larger than this size will be tracked
                  </Form.Text>
                </Form.Group>
                
                <Form.Group className="mb-3">
                  <Form.Label>Time Window (seconds)</Form.Label>
                  <Form.Control 
                    type="number" 
                    step="0.1"
                    value={localTimeWindow}
                    onChange={(e) => setLocalTimeWindow(parseFloat(e.target.value))}
                  />
                  <Form.Text className="text-muted">
                    Orders that disappear within this window are flagged
                  </Form.Text>
                </Form.Group>
                
                <Form.Group className="mb-3">
                  <Form.Label>Price Impact Threshold (%)</Form.Label>
                  <Form.Control 
                    type="number" 
                    step="0.1"
                    value={localPriceImpact}
                    onChange={(e) => setLocalPriceImpact(parseFloat(e.target.value))}
                  />
                  <Form.Text className="text-muted">
                    Used for momentum ignition detection
                  </Form.Text>
                </Form.Group>
                
                <Form.Group className="mb-3">
                  <Form.Label>Layering Threshold (orders)</Form.Label>
                  <Form.Control 
                    type="number" 
                    step="1"
                    value={localLayeringThreshold}
                    onChange={(e) => setLocalLayeringThreshold(parseInt(e.target.value))}
                  />
                  <Form.Text className="text-muted">
                    Minimum layers for layering detection
                  </Form.Text>
                </Form.Group>
                
                <Form.Group className="mb-3">
                  <Form.Label>Detection Patterns</Form.Label>
                  <div className="d-flex flex-column">
                    <Form.Check 
                      type="checkbox"
                      id="detect-spoofing"
                      label="Classic Spoofing"
                      checked={localPatternSettings.detectSpoofing}
                      onChange={e => setLocalPatternSettings(prev => ({
                        ...prev,
                        detectSpoofing: e.target.checked
                      }))}
                    />
                    <Form.Check 
                      type="checkbox"
                      id="detect-layering"
                      label="Order Layering"
                      checked={localPatternSettings.detectLayering}
                      onChange={e => setLocalPatternSettings(prev => ({
                        ...prev,
                        detectLayering: e.target.checked
                      }))}
                    />
                    <Form.Check 
                      type="checkbox"
                      id="detect-iceberg"
                      label="Iceberg Orders"
                      checked={localPatternSettings.detectIceberg}
                      onChange={e => setLocalPatternSettings(prev => ({
                        ...prev,
                        detectIceberg: e.target.checked
                      }))}
                    />
                    <Form.Check 
                      type="checkbox"
                      id="detect-momentum"
                      label="Momentum Ignition"
                      checked={localPatternSettings.detectMomentum}
                      onChange={e => setLocalPatternSettings(prev => ({
                        ...prev,
                        detectMomentum: e.target.checked
                      }))}
                    />
                  </div>
                </Form.Group>
                
                <Button 
                  variant="primary" 
                  type="submit" 
                  className="w-100"
                >
                  Apply Settings
                </Button>
              </Form>
            </Card.Body>
          </Card>
        </Col>
        
        <Col lg={8}>
          <Card className="shadow-sm h-100">
            <Card.Header className="bg-white d-flex justify-content-between align-items-center">
              <h5 className="mb-0">Order Book</h5>
              <Badge bg="danger" pill>LIVE</Badge>
            </Card.Header>
            <Card.Body>
              {orderBookData.bids.length > 0 && orderBookData.asks.length > 0 ? (
                <>
                  <Row className="mb-4">
                    <Col md={6} className="text-center">
                      <Card className="bg-light">
                        <Card.Body className="py-2 px-3">
                          <small className="d-block text-muted">Best Bid</small>
                          <div className="text-success fw-bold">
                            ${orderBookData.bids[0][0].toLocaleString(undefined, {
                              minimumFractionDigits: getDynamicPrecision(orderBookData.bids[0][0]),
                              maximumFractionDigits: getDynamicPrecision(orderBookData.bids[0][0])
                            })}
                          </div>
                        </Card.Body>
                      </Card>
                    </Col>
                    <Col md={6} className="text-center">
                      <Card className="bg-light">
                        <Card.Body className="py-2 px-3">
                          <small className="d-block text-muted">Best Ask</small>
                          <div className="text-danger fw-bold">
                            ${orderBookData.asks[0][0].toLocaleString(undefined, {
                              minimumFractionDigits: getDynamicPrecision(orderBookData.asks[0][0]),
                              maximumFractionDigits: getDynamicPrecision(orderBookData.asks[0][0])
                            })}
                          </div>
                        </Card.Body>
                      </Card>
                    </Col>
                  </Row>
                  {renderOrderBook()}
                  
                  <div className="text-center mt-3">
                    <small className="text-muted">
                      Highlighted rows indicate large orders of interest (≥ {minOrderSize} units)
                    </small>
                  </div>
                </>
              ) : (
                <div className="d-flex justify-content-center align-items-center" style={{ height: '400px' }}>
                  <Spinner animation="border" variant="primary" />
                  <span className="ms-2">Loading order book data...</span>
                </div>
              )}
            </Card.Body>
          </Card>
        </Col>
      </Row>
      
      <Card className="shadow-sm mb-4">
        <Card.Header className="bg-white">
          <h5 className="mb-0">About Market Manipulation Detection</h5>
        </Card.Header>
        <Card.Body>
          <div className="row">
            <div className="col-md-6">
              <h6 className="mb-2">Classic Spoofing</h6>
              <p>
                Placing large orders with no intention to execute them, then quickly canceling.
                The system tracks large orders and flags them if they're removed within the 
                specified time window.
              </p>
              
              <h6 className="mb-2">Order Layering</h6>
              <p>
                Creating multiple orders at different price levels to create a false impression
                of market depth. The system detects patterns of layered orders exceeding the
                layering threshold.
              </p>
            </div>
            
            <div className="col-md-6">
              <h6 className="mb-2">Iceberg Orders</h6>
              <p>
                Orders that are repeatedly placed at the same price level after partial
                executions. The system identifies frequent updates at the same price level.
              </p>
              
              <h6 className="mb-2">Momentum Ignition</h6>
              <p>
                Entering orders or series of orders to trigger stops and algorithms.
                The system calculates potential price impact to detect this pattern.
              </p>
            </div>
          </div>
          
          <Alert variant="warning">
            <AlertTriangle size={20} className="me-2" />
            Remember that these are potential indicators only. Not all flagged events represent
            actual market manipulation, and not all manipulation will be detected.
          </Alert>
        </Card.Body>
      </Card>
      
      <Card className="shadow-sm">
        <Card.Header className="bg-white d-flex justify-content-between align-items-center">
          <h5 className="mb-0">Detected Manipulation Events</h5>
          <Badge bg="danger" pill>LIVE</Badge>
        </Card.Header>
        <Card.Body className="p-0">
          <Table hover responsive className="mb-0">
            <thead className="bg-light">
              <tr>
                <th>Time</th>
                <th>Pair</th>
                <th>Pattern</th>
                <th>Price</th>
                <th>Quantity</th>
                <th>Type</th>
                <th>Duration</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {spoofEvents.map(event => (
                <tr key={event.id}>
                  <td>{event.time}</td>
                  <td>{event.pair}</td>
                  <td>
                    <Badge bg={
                      event.pattern === 'Classic Spoofing' ? 'warning' :
                      event.pattern === 'Order Layering' ? 'info' :
                      event.pattern === 'Iceberg Order' ? 'secondary' :
                      event.pattern === 'Momentum Ignition' ? 'danger' : 'primary'
                    }>
                      {event.pattern}
                    </Badge>
                  </td>
                  <td>${typeof event.price === 'number' ? event.price.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  }) : event.price}</td>
                  <td>{event.quantity}</td>
                  <td>
                    <Badge bg={event.type === 'Bid' ? 'success' : 'danger'}>
                      {event.type}
                    </Badge>
                  </td>
                  <td>{event.duration}</td>
                  <td>
                    <Button 
                      variant="outline-secondary" 
                      size="sm"
                      onClick={() => alert(`Details for ${event.pattern} event at ${event.time}: ${event.type} of ${event.quantity} ${event.pair} at ${event.price}`)}
                    >
                      View
                    </Button>
                  </td>
                </tr>
              ))}
              
              {spoofEvents.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-4">
                    No market manipulation events detected yet. Watching for patterns with current settings...
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        </Card.Body>
        <Card.Footer className="bg-white">
          <div className="d-flex justify-content-between align-items-center">
            <div>
              <small className="text-muted">
                Showing {Math.min(spoofEvents.length, 20)} of {spoofEvents.length} events
              </small>
            </div>
            <div>
              <Button 
                variant="outline-primary" 
                size="sm"
                disabled={spoofEvents.length <= 20}
              >
                Load More
              </Button>
            </div>
          </div>
        </Card.Footer>
      </Card>
    </div>
  );
};

// Market Data component
const MarketData = ({ 
  cryptoData, 
  exchangeInfo, 
  selectedSymbol, 
  setSelectedSymbol,
  lastPrices
}) => {
  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-4">
        <h2>Market Data</h2>
        <Form.Group className="d-flex align-items-center" style={{ width: '300px' }}>
          <Form.Label className="me-2 mb-0">Symbol:</Form.Label>
          <Form.Select 
            value={selectedSymbol} 
            onChange={(e) => setSelectedSymbol(e.target.value)}
          >
            {cryptoData.map(crypto => (
              <option key={crypto.symbol} value={crypto.symbol}>
                {crypto.symbol}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
      </div>
      
      <Row className="mb-4">
        <Col>
          <Card className="shadow-sm">
            <Card.Header className="bg-white d-flex justify-content-between align-items-center">
              <h5 className="mb-0">Selected Trading Pairs</h5>
              <Badge bg="success">{cryptoData.length} pairs</Badge>
            </Card.Header>
            <Card.Body className="p-0">
              <Table hover responsive className="mb-0">
                <thead className="bg-light">
                  <tr>
                    <th>#</th>
                    <th>Symbol</th>
                    <th>Base Asset</th>
                    <th>Quote Asset</th>
                    <th>Last Price</th>
                    <th>Status</th>
                    <th>Classic Spoofing</th>
                    <th>Layering</th>
                    <th>Iceberg</th>
                    <th>Momentum</th>
                  </tr>
                </thead>
                <tbody>
                  {cryptoData.map((crypto, index) => (
                    <tr 
                      key={crypto.id}
                      className={crypto.symbol === selectedSymbol ? 'table-primary' : ''}
                      onClick={() => setSelectedSymbol(crypto.symbol)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>{index + 1}</td>
                      <td className="fw-bold">{crypto.symbol}</td>
                      <td>{crypto.baseAsset}</td>
                      <td>{crypto.quoteAsset}</td>
                      <td>
                        ${lastPrices[crypto.symbol] ? lastPrices[crypto.symbol].toLocaleString(undefined, {
                          minimumFractionDigits: getDynamicPrecision(lastPrices[crypto.symbol]),
                          maximumFractionDigits: getDynamicPrecision(lastPrices[crypto.symbol])
                        }) : '—'}
                      </td>
                      <td>
                        <Badge bg="success">TRADING</Badge>
                      </td>
                      <td>
                        <Badge bg={crypto.spoofEvents > 0 ? 'warning' : 'secondary'}>
                          {crypto.spoofEvents}
                        </Badge>
                      </td>
                      <td>
                        <Badge bg={crypto.layeringEvents > 0 ? 'info' : 'secondary'}>
                          {crypto.layeringEvents}
                        </Badge>
                      </td>
                      <td>
                        <Badge bg={crypto.icebergEvents > 0 ? 'secondary' : 'secondary'}>
                          {crypto.icebergEvents}
                        </Badge>
                      </td>
                      <td>
                        <Badge bg={crypto.momentumEvents > 0 ? 'danger' : 'secondary'}>
                          {crypto.momentumEvents}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Col>
      </Row>
      
      <Row>
        <Col lg={6}>
          <Card className="shadow-sm mb-4">
            <Card.Header className="bg-white">
              <h5 className="mb-0">Detection Statistics</h5>
            </Card.Header>
            <Card.Body>
              <div className="mb-4">
                <h6>Total Events by Type</h6>
                <div className="d-flex justify-content-between mb-2 p-2 bg-light rounded">
                  <span>Classic Spoofing:</span>
                  <span className="fw-bold text-warning">
                    {cryptoData.reduce((sum, crypto) => sum + crypto.spoofEvents, 0)}
                  </span>
                </div>
                <div className="d-flex justify-content-between mb-2 p-2 bg-light rounded">
                  <span>Order Layering:</span>
                  <span className="fw-bold text-info">
                    {cryptoData.reduce((sum, crypto) => sum + crypto.layeringEvents, 0)}
                  </span>
                </div>
                <div className="d-flex justify-content-between mb-2 p-2 bg-light rounded">
                  <span>Iceberg Orders:</span>
                  <span className="fw-bold text-secondary">
                    {cryptoData.reduce((sum, crypto) => sum + crypto.icebergEvents, 0)}
                  </span>
                </div>
                <div className="d-flex justify-content-between p-2 bg-light rounded">
                  <span>Momentum Ignition:</span>
                  <span className="fw-bold text-danger">
                    {cryptoData.reduce((sum, crypto) => sum + crypto.momentumEvents, 0)}
                  </span>
                </div>
              </div>
              
              <div>
                <h6>Top Manipulation Pairs</h6>
                <ul className="list-group">
                  {cryptoData
                    .filter(crypto => crypto.totalEvents > 0)
                    .sort((a, b) => b.totalEvents - a.totalEvents)
                    .slice(0, 5)
                    .map(crypto => (
                      <li 
                        key={crypto.symbol} 
                        className="list-group-item d-flex justify-content-between align-items-center"
                        onClick={() => setSelectedSymbol(crypto.symbol)}
                        style={{ cursor: 'pointer' }}
                      >
                        <span>{crypto.symbol}</span>
                        <Badge bg="danger" pill>{crypto.totalEvents}</Badge>
                      </li>
                    ))
                  }
                  
                  {cryptoData.every(crypto => crypto.totalEvents === 0) && (
                    <li className="list-group-item text-center text-muted">
                      No manipulation events detected yet
                    </li>
                  )}
                </ul>
              </div>
            </Card.Body>
          </Card>
        </Col>
        
        <Col lg={6}>
          <Card className="shadow-sm mb-4">
            <Card.Header className="bg-white">
              <h5 className="mb-0">Manipulation Detection Guide</h5>
            </Card.Header>
            <Card.Body>
              <div className="mb-3">
                <h6 className="mb-2 d-flex align-items-center">
                  <Badge bg="warning" className="me-2">1</Badge>
                  Classic Spoofing
                </h6>
                <p>
                  The placement of large orders with the intent to cancel before execution.
                  These orders create a false impression of market depth/direction.
                  <br/>
                  <small className="text-muted">Detection: Large orders that disappear within a short time window.</small>
                </p>
              </div>
              
              <div className="mb-3">
                <h6 className="mb-2 d-flex align-items-center">
                  <Badge bg="info" className="me-2">2</Badge>
                  Order Layering
                </h6>
                <p>
                  Multiple orders at different price levels, typically in one direction,
                  creating an artificial appearance of market depth to influence other traders.
                  <br/>
                  <small className="text-muted">Detection: Multiple large orders in succession at incrementally worse prices.</small>
                </p>
              </div>
              
              <div className="mb-3">
                <h6 className="mb-2 d-flex align-items-center">
                  <Badge bg="secondary" className="me-2">3</Badge>
                  Iceberg Orders
                </h6>
                <p>
                  Large orders that are disguised by showing only a small portion at a time.
                  Not inherently manipulative, but can hide large interests.
                  <br/>
                  <small className="text-muted">Detection: Repeated order additions at the same price level after executions.</small>
                </p>
              </div>
              
              <div>
                <h6 className="mb-2 d-flex align-items-center">
                  <Badge bg="danger" className="me-2">4</Badge>
                  Momentum Ignition
                </h6>
                <p>
                  Placing orders to trigger other participants into accelerating or creating price movements.
                  Often used to trigger stop losses or algorithmic trading reactions.
                  <br/>
                  <small className="text-muted">Detection: Large orders with significant potential price impact.</small>
                </p>
              </div>
            </Card.Body>
          </Card>
        </Col>
      </Row>
      
      <Row>
        <Col>
          <Card className="shadow-sm">
            <Card.Header className="bg-white">
              <h5 className="mb-0">Pattern Recognition Algorithms</h5>
            </Card.Header>
            <Card.Body>
              <p>
                This system uses multiple pattern recognition algorithms to detect potential market manipulation
                in real-time. The detection works by analyzing order book data, trade executions, and market 
                conditions for each cryptocurrency pair.
              </p>
              
              <Table className="mb-0">
                <thead className="table-light">
                  <tr>
                    <th>Algorithm</th>
                    <th>Description</th>
                    <th>Parameters</th>
                    <th>False Positive Risk</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Classic Spoofing</td>
                    <td>Tracks large orders and their lifetime in the order book</td>
                    <td>Min Order Size, Time Window</td>
                    <td>Medium - Some large orders legitimately get canceled quickly</td>
                  </tr>
                  <tr>
                    <td>Order Layering</td>
                    <td>Detects multiple large orders at incrementally worse prices</td>
                    <td>Min Order Size, Layering Threshold</td>
                    <td>Low - Specific pattern is uncommon in normal trading</td>
                  </tr>
                  <tr>
                    <td>Iceberg Detection</td>
                    <td>Identifies repeated order placement at the same price level</td>
                    <td>Min Order Size, Update Frequency</td>
                    <td>High - Many legitimate large orders use iceberg techniques</td>
                  </tr>
                  <tr>
                    <td>Momentum Ignition</td>
                    <td>Calculates potential price impact of large orders</td>
                    <td>Min Order Size, Price Impact Threshold</td>
                    <td>Medium-High - Market makers often place large orders near price levels</td>
                  </tr>
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

// Footer component
const Footer = () => {
  return (
    <footer className="bg-dark text-white py-4">
      <Container>
        <Row>
          <Col md={6}>
            <h5 className="mb-3">Crypto Market Monitor</h5>
            <p className="mb-0">
              A comprehensive platform for monitoring cryptocurrency markets and detecting potential
              market manipulation activities in real-time using data from Binance Futures API.
            </p>
          </Col>
          <Col md={3} className="mt-4 mt-md-0">
            <h6>Quick Links</h6>
            <Nav className="flex-column">
              <Nav.Link href="#" className="text-white-50 p-0 mb-1">Dashboard</Nav.Link>
              <Nav.Link href="#" className="text-white-50 p-0 mb-1">Spoof Detector</Nav.Link>
              <Nav.Link href="#" className="text-white-50 p-0 mb-1">Market Data</Nav.Link>
              <Nav.Link href="#" className="text-white-50 p-0">Documentation</Nav.Link>
            </Nav>
          </Col>
          <Col md={3} className="mt-4 mt-md-0">
            <h6>Legal</h6>
            <Nav className="flex-column">
              <Nav.Link href="#" className="text-white-50 p-0 mb-1">Terms of Service</Nav.Link>
              <Nav.Link href="#" className="text-white-50 p-0 mb-1">Privacy Policy</Nav.Link>
              <Nav.Link href="#" className="text-white-50 p-0 mb-1">Disclaimer</Nav.Link>
              <Nav.Link href="#" className="text-white-50 p-0">Contact Us</Nav.Link>
            </Nav>
          </Col>
        </Row>
        <hr className="my-3" />
        <div className="d-flex justify-content-between align-items-center">
          <small className="text-white-50">&copy; 2025 Crypto Market Monitor. All rights reserved.</small>
          <div>
            <Button variant="outline-light" size="sm" className="me-2">GitHub</Button>
            <Button variant="outline-light" size="sm">Twitter</Button>
          </div>
        </div>
      </Container>
    </footer>
  );
};

export default App;