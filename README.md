# Crypto Market Monitor
A comprehensive platform for monitoring cryptocurrency markets and detecting potential market manipulation activities in real-time using data from Binance Futures API.
# Market Manipulation Detection Patterns

## 1. Classic Spoofing

**Description:**  
The placement of large orders with the intent to cancel before execution. These orders create a false impression of market depth/direction.

**Detection:**  
Large orders that disappear within a short time window.

---

## 2. Order Layering

**Description:**  
Multiple orders at different price levels, typically in one direction, creating an artificial appearance of market depth to influence other traders.

**Detection:**  
Multiple large orders in succession at incrementally worse prices.

---

## 3. Iceberg Orders

**Description:**  
Large orders that are disguised by showing only a small portion at a time. Not inherently manipulative, but can hide large interests.

**Detection:**  
Repeated order additions at the same price level after executions.

---

## 4. Momentum Ignition

**Description:**  
Placing orders to trigger other participants into accelerating or creating price movements. Often used to trigger stop losses or algorithmic trading reactions.

**Detection:**  
Large orders with significant potential price impact.


![Screenshot 2025-05-02 at 6 49 45 PM](https://github.com/user-attachments/assets/7d465f94-4bfa-4674-b3a9-04dd00dd78fc)
![Screenshot 2025-05-02 at 6 50 38 PM](https://github.com/user-attachments/assets/74911f92-01bc-4403-b06e-25b2dd4d69fe)
![Screenshot 2025-05-02 at 6 50 56 PM](https://github.com/user-attachments/assets/a05c50e8-e34a-486c-b0b6-25424a541f56)


