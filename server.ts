import express from 'express';
import { createServer as createViteServer } from 'vite';
import { Telegraf, Markup } from 'telegraf';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import dotenv from 'dotenv';
import firebaseConfig from './firebase-applet-config.json';

import axios from 'axios';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const NP_API_KEY = process.env.NOVA_POSHTA_API_KEY;
const SHOP_CITY_REF = '8d5a980d-391c-11dd-90d9-001a92567626'; // Kyiv

import { initializeApp as initializeClientApp } from 'firebase/app';
import { getFirestore as getClientFirestore, collection, getDocs, query, limit, where, orderBy, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc } from 'firebase/firestore';

// Initialize Firebase Admin for other tasks (like Auth if needed)
if (getApps().length === 0) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

// Initialize Firebase Client SDK for Firestore access (workaround for PERMISSION_DENIED)
const clientApp = initializeClientApp(firebaseConfig);
const db = getClientFirestore(clientApp, firebaseConfig.firestoreDatabaseId);

console.log(`Firebase Client SDK initialized for Firestore: ${firebaseConfig.firestoreDatabaseId}`);

console.log(`Firebase Admin initialized for project: ${firebaseConfig.projectId}, database: ${firebaseConfig.firestoreDatabaseId}`);

// Initialize Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN || '');

// --- Bot Logic ---

interface CartItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

// --- Nova Poshta API Functions ---
async function searchCities(query: string) {
  try {
    const response = await axios.post('https://api.novaposhta.ua/v2.0/json/', {
      apiKey: NP_API_KEY,
      modelName: 'Address',
      calledMethod: 'getCities',
      methodProperties: {
        FindByString: query,
        Limit: '10'
      }
    });
    return response.data.data;
  } catch (err) {
    console.error('NP Search Cities Error:', err);
    return [];
  }
}

async function getWarehouses(cityRef: string) {
  try {
    const response = await axios.post('https://api.novaposhta.ua/v2.0/json/', {
      apiKey: NP_API_KEY,
      modelName: 'Address',
      calledMethod: 'getWarehouses',
      methodProperties: {
        CityRef: cityRef
      }
    });
    return response.data.data;
  } catch (err) {
    console.error('NP Get Warehouses Error:', err);
    return [];
  }
}

async function calculateNPShipping(cityRecipientRef: string, itemsTotal: number) {
  try {
    const response = await axios.post('https://api.novaposhta.ua/v2.0/json/', {
      apiKey: NP_API_KEY,
      modelName: 'InternetDocument',
      calledMethod: 'getDocumentPrice',
      methodProperties: {
        CitySender: SHOP_CITY_REF,
        CityRecipient: cityRecipientRef,
        Weight: '1',
        ServiceType: 'WarehouseWarehouse',
        Cost: itemsTotal.toString(),
        CargoType: 'Cargo'
      }
    });
    return response.data.data[0]?.Cost || 120;
  } catch (err) {
    console.error('NP Calculate Shipping Error:', err);
    return 120;
  }
}

const userCarts: Record<number, CartItem[]> = {};
const userStates: Record<number, string> = {};
const userDeliveryData: Record<number, { cityRef?: string, cityName?: string, oblastName?: string }> = {};

// Removed hardcoded DELIVERY_POINTS

bot.start(async (ctx) => {
  try {
    const welcomeMessage = `Вітаємо у нашому магазині! 🛍\n\nТут ви можете переглянути товари та зробити замовлення.`;
    await ctx.reply(welcomeMessage, Markup.keyboard([
      ['📦 Товари', '🛒 Кошик'],
      ['👤 Профіль', '📜 Мої замовлення'],
      ['📜 Угода']
    ]).resize());
  } catch (err) {
    console.error('Bot start error:', err);
  }
});

bot.hears('📦 Товари', async (ctx) => {
  try {
    const productsRef = collection(db, 'products');
    const snapshot = await getDocs(productsRef);
    
    if (snapshot.empty) {
      return ctx.reply('На жаль, зараз немає доступних товарів.');
    }

    for (const d of snapshot.docs) {
      const product = d.data();
      const message = `*${product.name}*\n${product.description}\nЦіна: ${product.price} грн`;
      
      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Додати в кошик 🛒', `add_${d.id}`)]
      ]);

      if (product.imageUrl) {
        await ctx.replyWithPhoto(product.imageUrl, {
          caption: message,
          parse_mode: 'Markdown',
          ...keyboard
        });
      } else {
        await ctx.replyWithMarkdown(message, keyboard);
      }
    }
  } catch (err) {
    console.error('Bot products error:', err);
    await ctx.reply('Сталася помилка при отриманні списку товарів.');
  }
});

bot.action(/^add_(.+)$/, async (ctx) => {
  try {
    const productId = ctx.match[1];
    const productDoc = await getDoc(doc(db, 'products', productId));
    
    if (!productDoc.exists()) {
      return ctx.answerCbQuery('Товар не знайдено.');
    }

    const product = productDoc.data()!;
    const userId = ctx.from!.id;

    if (!userCarts[userId]) userCarts[userId] = [];
    
    const existingItem = userCarts[userId].find(item => item.productId === productId);
    if (existingItem) {
      existingItem.quantity += 1;
    } else {
      userCarts[userId].push({
        productId,
        name: product.name,
        price: product.price,
        quantity: 1
      });
    }

    await ctx.answerCbQuery('Додано в кошик!');
  } catch (err) {
    console.error('Bot add to cart error:', err);
    await ctx.answerCbQuery('Помилка при додаванні в кошик.');
  }
});

bot.hears('🛒 Кошик', async (ctx) => {
  try {
    const userId = ctx.from!.id;
    const cart = userCarts[userId] || [];

    if (cart.length === 0) {
      return ctx.reply('Ваш кошик порожній.');
    }

    let total = 0;
    let message = '🛒 *Ваш кошик:*\n\n';
    
    cart.forEach((item, index) => {
      const subtotal = item.price * item.quantity;
      total += subtotal;
      message += `${index + 1}. ${item.name} x${item.quantity} = ${subtotal} грн\n`;
    });

    message += `\n*Разом: ${total} грн*`;

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('Оформити замовлення ✅', 'checkout')],
      [Markup.button.callback('Очистити кошик 🗑', 'clear_cart')]
    ]));
  } catch (err) {
    console.error('Bot cart error:', err);
  }
});

bot.action('clear_cart', async (ctx) => {
  userCarts[ctx.from!.id] = [];
  await ctx.answerCbQuery('Кошик очищено.');
  await ctx.editMessageText('Кошик порожній.');
});

bot.action('checkout', async (ctx) => {
  try {
    const userId = ctx.from!.id;
    const userDoc = await getDoc(doc(db, 'users', userId.toString()));
    
    if (userDoc.exists() && userDoc.data().address) {
      const address = userDoc.data().address;
      await ctx.reply(`Використати збережену адресу?\n📍 ${address}`, Markup.inlineKeyboard([
        [Markup.button.callback('Так, використати ✅', 'use_saved_address')],
        [Markup.button.callback('Ні, вибрати іншу ✏️', 'select_city')]
      ]));
    } else {
      await startCitySearch(ctx);
    }
  } catch (err) {
    console.error('Checkout error:', err);
    await ctx.reply('Помилка при оформленні замовлення.');
  }
});

bot.action('use_saved_address', async (ctx) => {
  try {
    const userId = ctx.from!.id;
    const cart = userCarts[userId] || [];
    const userDoc = await getDoc(doc(db, 'users', userId.toString()));
    const address = userDoc.data()?.address || '';
    const cityRef = userDoc.data()?.cityRef || SHOP_CITY_REF;

    if (cart.length > 0 && address) {
      const itemsTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const shippingCost = await calculateNPShipping(cityRef, itemsTotal);
      const total = itemsTotal + Number(shippingCost);

      const orderData = {
        userId: userId.toString(),
        userName: ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : ''),
        items: cart,
        itemsTotal,
        shippingCost: Number(shippingCost),
        total,
        status: 'pending',
        createdAt: new Date().toISOString(),
        addressInfo: address
      };

      await addDoc(collection(db, 'orders'), orderData);
      userCarts[userId] = [];
      await ctx.answerCbQuery();
      await ctx.editMessageText(`Дякуємо! Ваше замовлення прийнято. ✅\n\nСума товарів: ${itemsTotal} грн\nДоставка: ${shippingCost} грн\n*Разом до сплати: ${total} грн*`, { parse_mode: 'Markdown' });
    } else {
      await ctx.answerCbQuery('Кошик порожній або адреса не знайдена.');
    }
  } catch (err) {
    console.error('Use saved address error:', err);
  }
});

bot.hears('👤 Профіль', async (ctx) => {
  try {
    const userId = ctx.from!.id;
    const userDoc = await getDoc(doc(db, 'users', userId.toString()));
    const userData = userDoc.exists() ? userDoc.data() : null;

    let message = `👤 *Ваш профіль:*\n\n`;
    message += `Ім'я: ${ctx.from!.first_name}\n`;
    message += `ID: ${userId}\n`;
    message += `📍 Адреса доставки: ${userData?.address || 'не вказано'}\n`;

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('Змінити адресу ✏️', 'edit_address')]
    ]));
  } catch (err) {
    console.error('Profile error:', err);
    await ctx.reply('Помилка при отриманні профілю.');
  }
});

async function startCitySearch(ctx: any) {
  const userId = ctx.from!.id;
  userStates[userId] = 'awaiting_city_search';
  await ctx.reply('Напишіть назву вашого міста (наприклад: Київ або Шептицький):');
}

bot.action('select_city', async (ctx) => {
  await ctx.answerCbQuery();
  await startCitySearch(ctx);
});

bot.action(/^np_city_(.+)$/, async (ctx) => {
  try {
    const cityRef = ctx.match[1];
    const warehouses = await getWarehouses(cityRef);
    const userId = ctx.from!.id;

    if (warehouses.length === 0) {
      return ctx.answerCbQuery('Відділень не знайдено.');
    }

    // Store cityRef temporarily
    if (!userDeliveryData[userId]) userDeliveryData[userId] = {};
    userDeliveryData[userId].cityRef = cityRef;

    // Show first 15 warehouses to avoid long messages
    const buttons = warehouses.slice(0, 15).map((w: any) => [Markup.button.callback(w.Description, `np_wh_${w.Ref.substring(0, 30)}`)]);
    
    // Store full warehouse list in memory for this session if needed, but here we'll just use the Ref
    // Note: Callback data limit is 64 bytes. NP Refs are usually 36 chars.
    
    await ctx.answerCbQuery();
    await ctx.editMessageText('Виберіть відділення:', Markup.inlineKeyboard(buttons));
  } catch (err) {
    console.error('NP City Selection Error:', err);
    await ctx.answerCbQuery('Помилка.');
  }
});

bot.action(/^np_wh_(.+)$/, async (ctx) => {
  try {
    const whRefPrefix = ctx.match[1];
    const userId = ctx.from!.id;
    const cityRef = userDeliveryData[userId]?.cityRef;

    if (!cityRef) return ctx.answerCbQuery('Спочатку виберіть місто.');

    const warehouses = await getWarehouses(cityRef);
    const warehouse = warehouses.find((w: any) => w.Ref.startsWith(whRefPrefix));

    if (!warehouse) return ctx.answerCbQuery('Відділення не знайдено.');

    const fullAddress = `${warehouse.CityDescription}, ${warehouse.Description}`;
    
    // Save to profile
    await setDoc(doc(db, 'users', userId.toString()), {
      address: fullAddress,
      cityRef: cityRef,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    const cart = userCarts[userId] || [];
    if (cart.length > 0) {
      const itemsTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const shippingCost = await calculateNPShipping(cityRef, itemsTotal);
      const total = itemsTotal + Number(shippingCost);

      const orderData = {
        userId: userId.toString(),
        userName: ctx.from!.first_name + (ctx.from!.last_name ? ` ${ctx.from!.last_name}` : ''),
        items: cart,
        itemsTotal,
        shippingCost: Number(shippingCost),
        total,
        status: 'pending',
        createdAt: new Date().toISOString(),
        addressInfo: fullAddress
      };

      await addDoc(collection(db, 'orders'), orderData);
      userCarts[userId] = [];
      await ctx.answerCbQuery('Замовлення оформлено!');
      await ctx.editMessageText(`Дякуємо! Ваше замовлення прийнято. ✅\n\n📍 Адреса: ${fullAddress}\n\nСума товарів: ${itemsTotal} грн\nДоставка: ${shippingCost} грн\n*Разом до сплати: ${total} грн*`, { parse_mode: 'Markdown' });
    } else {
      await ctx.answerCbQuery('Адресу збережено!');
      await ctx.editMessageText(`Адресу успішно збережено: ${fullAddress} ✅`);
    }
    
    delete userStates[userId];
  } catch (err) {
    console.error('NP Warehouse Selection Error:', err);
    await ctx.answerCbQuery('Помилка.');
  }
});

bot.action('edit_address', async (ctx) => {
  await ctx.answerCbQuery();
  await startCitySearch(ctx);
});

bot.on('text', async (ctx, next) => {
  try {
    const text = ctx.message.text;
    if (['📦 Товари', '🛒 Кошик', '👤 Профіль', '📜 Мої замовлення', '📜 Угода'].includes(text)) return next();

    const userId = ctx.from!.id;
    const state = userStates[userId];

    if (state === 'awaiting_city_search') {
      const cities = await searchCities(text);
      if (cities.length === 0) {
        return ctx.reply('Міст не знайдено. Спробуйте ще раз (наприклад: Київ):');
      }
      const buttons = cities.map((city: any) => [Markup.button.callback(`${city.Description} (${city.AreaDescription})`, `np_city_${city.Ref}`)]);
      await ctx.reply(`Знайдено міста за запитом "${text}":`, Markup.inlineKeyboard(buttons));
      return;
    }

    await ctx.reply('Я вас не розумію. Використовуйте меню нижче.');
  } catch (error) {
    console.error('Text handler error:', error);
    await ctx.reply('Вибачте, сталася помилка.');
  }
});

bot.hears('📜 Угода', async (ctx) => {
  const agreementText = `📜 *Угода користувача та Відмова від відповідальності*

1. **Загальні положення**
1.1. Користуючись цим ботом, ви підтверджуєте, що повністю ознайомлені та згодні з усіма пунктами даної Угоди.
1.2. Магазин працює виключно як торговельний майданчик і не несе відповідальності за будь-які прямі чи непрямі наслідки використання сервісу або придбаних товарів.

2. **Вікові обмеження (18+)**
2.1. Купівля будь-яких товарів у нашому магазині дозволена **суворо особам, які досягли 18-річного віку**.
2.2. Магазин залишає за собою право вимагати підтвердження віку в будь-який момент.
2.3. Якщо покупку здійснила особа, якій не виповнилося 18 років (шляхом надання неправдивих даних), магазин **повністю знімає з себе відповідальність** за будь-які можливі наслідки, шкоду чи юридичні аспекти. Відповідальність у такому разі покладається на законних представників неповнолітнього.

3. **Відмова від відповідальності за товар**
3.1. Магазин не несе відповідальності за якість, склад або дію товарів після їх передачі покупцеві.
3.2. Будь-які претензії щодо експлуатації товарів та можливої шкоди, завданої ними здоров'ю чи майну, магазином не приймаються. Ви використовуєте придбані речі на свій власний ризик.

4. **Доставка та логістика**
4.1. Магазин не несе відповідальності за роботу сторонніх служб доставки (зокрема "Нова Пошта").
4.2. Будь-які затримки, терміни, пошкодження товару під час транспортування або втрата посилки є виключною відповідальністю логістичної компанії.

5. **Конфіденційність**
5.1. Ви погоджуєтеся на обробку ваших персональних даних (ім'я, номер телефону, адреса) виключно для цілей оформлення та доставки замовлення.

6. **Заключні положення**
6.1. Адміністрація магазину має право відмовити в обслуговуванні будь-якому користувачу без пояснення причин.
6.2. Умови даної Угоди можуть бути змінені в будь-який момент. Продовження користування ботом означає згоду з оновленими умовами.`;

  await ctx.replyWithMarkdown(agreementText);
});

bot.hears('📜 Мої замовлення', async (ctx) => {
  try {
    const userId = ctx.from!.id.toString();
    const q = query(
      collection(db, 'orders'),
      where('userId', '==', userId),
      orderBy('createdAt', 'desc')
    );
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return ctx.reply('У вас ще немає замовлень.');
    }

    let message = '📜 *Ваші замовлення:*\n\n';
    snapshot.docs.forEach((d, index) => {
      const order = d.data();
      message += `${index + 1}. Замовлення від ${new Date(order.createdAt).toLocaleDateString()}\n`;
      message += `Статус: ${order.status}\n`;
      message += `Сума: ${order.total} грн\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (err) {
    console.error('Bot orders error:', err);
    await ctx.reply('Помилка при отриманні замовлень.');
  }
});

bot.catch((err: any, ctx) => {
  console.error(`Ooops, encountered an error for ${ctx.updateType}`, err);
  if (err.stack) console.error(err.stack);
});

bot.launch().catch(err => {
  console.error('Bot launch failed:', err);
  if (err.stack) console.error(err.stack);
});

// --- API Logic for Admin Panel ---

app.use(express.json());

app.get('/api/stats', async (req, res) => {
  try {
    const products = await getDocs(collection(db, 'products'));
    const orders = await getDocs(collection(db, 'orders'));
    const totalRevenue = orders.docs.reduce((sum, d) => sum + (d.data().total || 0), 0);
    
    res.json({
      productCount: products.size,
      orderCount: orders.size,
      totalRevenue
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, 'products'));
    const products = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const docRef = await addDoc(collection(db, 'products'), {
      ...req.body,
      createdAt: new Date().toISOString()
    });
    res.json({ id: docRef.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add product' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    await deleteDoc(doc(db, 'products', req.params.id));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const q = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
    const snapshot = await getDocs(q);
    const orders = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.patch('/api/orders/:id', async (req, res) => {
  try {
    const orderRef = doc(db, 'orders', req.params.id);
    await updateDoc(orderRef, { status: req.body.status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// --- Vite Middleware ---

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => console.error('Server start failed:', err));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
