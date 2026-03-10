FROM node:20-alpine

# Створюємо робочу директорію
WORKDIR /app

# Копіюємо package.json та package-lock.json
COPY package*.json ./

# Встановлюємо залежності
RUN npm install

# Копіюємо всі інші файли проєкту
COPY . .

# Будуємо фронтенд (якщо використовується адмін-панель на React/Vite)
RUN npm run build

# Відкриваємо порт 3000 для адмін-панелі
EXPOSE 3000

# Запускаємо бота (змінна NODE_ENV=production вже вшита у скрипт start в package.json)
CMD ["npm", "start"]
