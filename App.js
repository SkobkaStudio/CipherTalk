import React, { useState, useEffect, useRef } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  StyleSheet, Text, View, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, TextInput, Keyboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CryptoJS from 'crypto-js';
import * as WebBrowser from 'expo-web-browser';
import * as Location from 'expo-location';

const Tab = createBottomTabNavigator();

// ========== КОНСТАНТЫ ==========
const DEFAULT_CITY = { name: 'Москва', country: 'RU', latitude: 55.75, longitude: 37.62 };
const ENCRYPTION_KEY = 'InformatorSecret2026!';
const HOLIDAYS_URL = 'https://date.nager.at/api/v3/NextPublicHolidays/RU';
const HISTORY_URL = 'https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/';
const CRYPTO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,rub';
const CURRENCY_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

// ========== УТИЛИТЫ ==========
const encrypt = (text) => CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
const decrypt = (ciphertext) => {
  try { return CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8); }
  catch { return '[Ошибка]'; }
};

const formatTime = (d) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const formatDate = (d) => d.toLocaleDateString('ru-RU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const formatHolidayDate = (dateString) => new Date(dateString).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });

const weatherDesc = (c) => {
  if (c === 0) return 'Ясно ☀️';
  if (c <= 3) return 'Облачно ';
  if (c <= 48) return 'Туман 🌫️';
  if (c <= 67) return 'Дождь 🌧️';
  if (c <= 77) return 'Снег ❄️';
  if (c <= 95) return 'Гроза ⛈️';
  return 'Пасмурно ☁️';
};

const holidayTips = (name) => {
  const n = name.toLowerCase();
  if (n.includes('новый год')) return '🎄 Украсьте дом, загадайте желание!';
  if (n.includes('рождеств')) return '✨ Поставьте ёлку, подарите внимание близким!';
  if (n.includes('день победы')) return '🎖️ Посетите памятное место!';
  if (n.includes('8 март')) return '💐 Поздравьте женщин цветами!';
  return '🎉 Проведите день с близкими!';
};

// ========== ГЛАВНЫЙ ЭКРАН ==========
function HomeScreen() {
  const [time, setTime] = useState(new Date());
  const [selectedCity, setSelectedCity] = useState(DEFAULT_CITY);
  const [cityQuery, setCityQuery] = useState('');
  const [cityOptions, setCityOptions] = useState([]);
  const [weather, setWeather] = useState(null);
  const [holidays, setHolidays] = useState([]);
  const [historyEvents, setHistoryEvents] = useState([]);
  const [currencies, setCurrencies] = useState(null);
  const [crypto, setCrypto] = useState(null);
  const [loading, setLoading] = useState({ weather: true, holidays: true, history: true, currency: true });
  const [refreshing, setRefreshing] = useState(false);
  const [locationPermission, setLocationPermission] = useState('unknown');
  const isMounted = useRef(true);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    requestLocation();
    loadAllData();
    return () => { isMounted.current = false; };
  }, []);

  const requestLocation = async () => {
    setLocationPermission('loading');
    try {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setLocationPermission('denied'); return; }
      setLocationPermission('granted');
      let loc = await Location.getCurrentPositionAsync({});
      let rev = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
      if (rev.length > 0) {
        const newCity = {
          name: rev[0].city || rev[0].subregion || 'Мое место',
          country: rev[0].countryCode || 'RU',
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude
        };
        setSelectedCity(newCity);
        fetchWeather(newCity);
      }
    } catch (e) { console.log(e); }
  };

  const fetchWeather = async (city = selectedCity) => {
    setLoading(p => ({ ...p, weather: true }));
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${city.latitude}&longitude=${city.longitude}&current_weather=true&timezone=auto`);
      const d = await r.json();
      if (!isMounted.current) return;
      const code = d?.current_weather?.weathercode;
      setWeather({ temp: Math.round(d?.current_weather?.temperature ?? 0), desc: weatherDesc(code), city: city.name });
    } catch { setWeather({ temp: '--', desc: 'Нет данных', city: '' }); }
    finally { if (isMounted.current) setLoading(p => ({ ...p, weather: false })); }
  };

  const fetchHolidays = async () => {
    setLoading(p => ({ ...p, holidays: true }));
    try {
      const r = await fetch(HOLIDAYS_URL);
      const d = await r.json();
      if (!isMounted.current) return;
      setHolidays(Array.isArray(d) ? d.slice(0, 5) : []);
    } catch { setHolidays([]); }
    finally { if (isMounted.current) setLoading(p => ({ ...p, holidays: false })); }
  };

  const fetchHistory = async () => {
    setLoading(p => ({ ...p, history: true }));
    const today = new Date();
    try {
      const r = await fetch(`${HISTORY_URL}${today.getMonth() + 1}/${today.getDate()}`);
      const d = await r.json();
      if (!isMounted.current) return;
      setHistoryEvents(d?.events?.slice(0, 3) || []);
    } catch { setHistoryEvents([]); }
    finally { if (isMounted.current) setLoading(p => ({ ...p, history: false })); }
  };

  const fetchCurrencies = async () => {
    setLoading(p => ({ ...p, currency: true }));
    try {
      const [c1, c2] = await Promise.all([fetch(CURRENCY_URL), fetch(CRYPTO_URL)]);
      const d1 = await c1.json(), d2 = await c2.json();
      if (!isMounted.current) return;
      setCurrencies({
        usd: Math.round(d1?.Valute?.USD?.Value * 100) / 100,
        eur: Math.round(d1?.Valute?.EUR?.Value * 100) / 100
      });
      setCrypto({ btc: d2?.bitcoin?.usd || 0, eth: d2?.ethereum?.usd || 0 });
    } catch {}
    finally { if (isMounted.current) setLoading(p => ({ ...p, currency: false })); }
  };

  const loadAllData = async () => {
    await Promise.all([fetchWeather(), fetchHolidays(), fetchHistory(), fetchCurrencies()]);
  };

  const onRefresh = async () => { setRefreshing(true); await loadAllData(); setRefreshing(false); };

  const searchCity = async () => {
    if (!cityQuery.trim()) return;
    Keyboard.dismiss();
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityQuery.trim())}&count=5&language=ru&format=json`);
      const d = await r.json();
      setCityOptions(Array.isArray(d?.results) ? d.results.slice(0, 5) : []);
    } catch { setCityOptions([]); }
  };

  const chooseCity = (city) => {
    const s = { name: city.name, latitude: city.latitude, longitude: city.longitude, country: city.country ?? 'RU' };
    setSelectedCity(s);
    setCityQuery(`${s.name}, ${s.country}`);
    setCityOptions([]);
    fetchWeather(s);
  };

  return (
    <ScrollView contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <Text style={styles.title}>Информатор</Text>
      <Text style={styles.subtitle}>Всё важное в одном месте</Text>

      {locationPermission === 'denied' && (
        <TouchableOpacity style={styles.locButton} onPress={requestLocation}>
          <Text style={styles.locButtonText}>📍 Разрешить геопозицию</Text>
        </TouchableOpacity>
      )}

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>🕒 Сейчас в {selectedCity.name}</Text>
        <Text style={styles.time}>{formatTime(time)}</Text>
        <Text style={styles.date}>{formatDate(time)}</Text>
      </View>

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>🌤️ Погода</Text>
        {loading.weather ? <ActivityIndicator color="#ff9f7f" /> : (
          <View>
            <Text style={styles.temp}>{weather?.temp ?? '--'}°C</Text>
            <Text style={styles.desc}>{weather?.desc ?? 'Нет данных'}</Text>
            <Text style={styles.cityName}>{weather?.city ?? selectedCity.name}</Text>
          </View>
        )}
      </View>

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>💰 Курсы валют</Text>
        {loading.currency ? <ActivityIndicator color="#ff9f7f" /> : (
          <View>
            <View style={styles.currencyRow}>
              <Text style={styles.currencyLabel}>🇺🇸 Доллар</Text>
              <Text style={styles.currencyValue}>{currencies?.usd ?? '--'} ₽</Text>
            </View>
            <View style={styles.currencyRow}>
              <Text style={styles.currencyLabel}>🇪 Евро</Text>
              <Text style={styles.currencyValue}>{currencies?.eur ?? '--'} ₽</Text>
            </View>
            <View style={styles.currencyRow}>
              <Text style={styles.currencyLabel}>₿ Биткоин</Text>
              <Text style={styles.currencyValue}>${crypto?.btc ?? '--'}</Text>
            </View>
            <View style={styles.currencyRow}>
              <Text style={styles.currencyLabel}>💎 Эфириум</Text>
              <Text style={styles.currencyValue}>${crypto?.eth ?? '--'}</Text>
            </View>
          </View>
        )}
      </View>

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>📅 Сегодня в истории</Text>
        {loading.history ? <ActivityIndicator color="#ff9f7f" /> : historyEvents.length > 0 ? (
          historyEvents.map((e, i) => (
            <View key={i} style={styles.historyItem}>
              <Text style={styles.historyYear}>{e.year} год</Text>
              <Text style={styles.historyText}>{e.text}</Text>
            </View>
          ))
        ) : <Text style={styles.emptyText}>Нет данных</Text>}
      </View>

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>🎉 Ближайшие праздники</Text>
        {loading.holidays ? <ActivityIndicator color="#ff9f7f" /> : holidays.length > 0 ? (
          holidays.map(h => (
            <View key={h.date} style={styles.holidayItem}>
              <Text style={styles.holidayName}>{h.localName}</Text>
              <Text style={styles.holidayDate}>{formatHolidayDate(h.date)}</Text>
              <Text style={styles.holidayTip}>{holidayTips(h.localName)}</Text>
            </View>
          ))
        ) : <Text style={styles.emptyText}>Нет праздников</Text>}
      </View>

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>🔍 Найти город</Text>
        <TextInput
          style={styles.searchInput}
          value={cityQuery}
          onChangeText={setCityQuery}
          placeholder="Введите город"
          placeholderTextColor="#8ea1ff"
          onSubmitEditing={searchCity}
        />
        <TouchableOpacity style={styles.searchButton} onPress={searchCity}>
          <Text style={styles.searchButtonText}>Найти</Text>
        </TouchableOpacity>
        {cityOptions.length > 0 && (
          <View style={styles.optionsList}>
            {cityOptions.map((c, i) => (
              <TouchableOpacity key={i} style={styles.optionItem} onPress={() => chooseCity(c)}>
                <Text style={styles.optionText}>{c.name}, {c.country}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

// ========== НОВОСТИ ==========
function NewsScreen() {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchNews = async () => {
    setLoading(true);
    try {
      const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent('https://news.yandex.ru/news.rss')}`);
      const d = await r.json();
      setNews(Array.isArray(d?.items) ? d.items.slice(0, 15) : []);
    } catch {}
    finally { setLoading(false); }
  };

  useEffect(() => { fetchNews(); }, []);
  const onRefresh = async () => { setRefreshing(true); await fetchNews(); setRefreshing(false); };

  return (
    <ScrollView contentContainerStyle={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      <Text style={styles.title}>📰 Новости</Text>
      <View style={styles.widget}>
        {loading ? <ActivityIndicator color="#ff9f7f" /> : news.length > 0 ? (
          news.map((item, i) => (
            <TouchableOpacity key={i} style={styles.newsItem} onPress={() => WebBrowser.openBrowserAsync(item.link)}>
              <Text style={styles.newsTitle}>{item.title}</Text>
              <Text style={styles.newsMeta}>{item.pubDate?.slice(0, 16) ?? ''}</Text>
            </TouchableOpacity>
          ))
        ) : <Text style={styles.emptyText}>Нет новостей</Text>}
      </View>
    </ScrollView>
  );
}

// ========== ЗАЩИЩЁННЫЙ ЧАТ ==========
function ChatScreen() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLocked, setIsLocked] = useState(true);
  const [pin, setPin] = useState('');
  const [currentChat, setCurrentChat] = useState('bot');

  useEffect(() => {
    if (!isLocked) loadMessages();
  }, [isLocked, currentChat]);

  const loadMessages = async () => {
    try {
      const saved = await AsyncStorage.getItem(`chat_${currentChat}`);
      if (saved) {
        const decrypted = JSON.parse(saved).map(m => ({ ...m, text: decrypt(m.text) }));
        setMessages(decrypted);
      } else {
        const welcome = [{
          _id: 1,
          text: currentChat === 'bot' ? '🔒 Привет! Я защищённый бот. AES-256 активен.' :
                currentChat === 'group1' ? '👥 Группа "Разработка". Обсуждаем код.' :
                '👥 Группа "Новости". Делимся важным.',
          user: 'bot'
        }];
        setMessages(welcome);
        AsyncStorage.setItem(`chat_${currentChat}`, JSON.stringify(welcome.map(m => ({ ...m, text: encrypt(m.text) }))));
      }
    } catch {}
  };

  const saveMessages = async (msgs) => {
    const enc = msgs.map(m => ({ ...m, text: encrypt(m.text) }));
    await AsyncStorage.setItem(`chat_${currentChat}`, JSON.stringify(enc));
  };

  const sendMessage = () => {
    if (!input.trim()) return;
    const userMsg = { _id: Date.now(), text: input, user: 'user' };
    const updated = [...messages, userMsg];
    setMessages(updated);
    saveMessages(updated);
    setInput('');

    setTimeout(() => {
      const replies = {
        bot: ['🔒 Зашифровано!', '✅ Принято!', '️ Данные защищены.', 'Интересно!'],
        group1: ['💻 Интересная идея!', '🚀 Давай реализуем!', '🤔 А что насчет архитектуры?'],
        group2: ['📰 Важная новость!', '🔥 Горячо!', '️ Срочно!']
      };
      const list = replies[currentChat] || replies.bot;
      const botMsg = { _id: Date.now() + 1, text: list[Math.floor(Math.random() * list.length)], user: 'bot' };
      const withBot = [...updated, botMsg];
      setMessages(withBot);
      saveMessages(withBot);
    }, 800);
  };

  const checkPin = () => {
    if (pin === '1234') { setIsLocked(false); setPin(''); }
    else alert('Неверный PIN!');
  };

  if (isLocked) {
    return (
      <View style={styles.lockContainer}>
        <Text style={styles.lockIcon}>🔒</Text>
        <Text style={styles.lockTitle}>Защищённый мессенджер</Text>
        <Text style={styles.lockSubtitle}>Введите PIN для доступа</Text>
        <TextInput
          style={styles.pinInput}
          value={pin}
          onChangeText={setPin}
          placeholder="1234"
          keyboardType="numeric"
          maxLength={4}
        />
        <TouchableOpacity style={styles.unlockBtn} onPress={checkPin}>
          <Text style={styles.unlockText}>Разблокировать</Text>
        </TouchableOpacity>
        <Text style={styles.lockHint}>По умолчанию: 1234</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0e1226' }}>
      <View style={styles.chatHeader}>
        <Text style={styles.chatTitle}>
          💬 {currentChat === 'bot' ? 'Защищённый Бот' : currentChat === 'group1' ? 'Группа: Разработка' : 'Группа: Новости'}
        </Text>
        <TouchableOpacity onPress={() => setIsLocked(true)}>
          <Text style={{ fontSize: 22 }}>🔒</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.chatSwitcher}>
        <TouchableOpacity style={[styles.chatTab, currentChat === 'bot' && styles.chatTabActive]} onPress={() => setCurrentChat('bot')}>
          <Text style={[styles.chatTabText, currentChat === 'bot' && styles.chatTabTextActive]}>🤖 Бот</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.chatTab, currentChat === 'group1' && styles.chatTabActive]} onPress={() => setCurrentChat('group1')}>
          <Text style={[styles.chatTabText, currentChat === 'group1' && styles.chatTabTextActive]}>💻 Код</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.chatTab, currentChat === 'group2' && styles.chatTabActive]} onPress={() => setCurrentChat('group2')}>
          <Text style={[styles.chatTabText, currentChat === 'group2' && styles.chatTabTextActive]}>📰 Новости</Text>
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.chatList} showsVerticalScrollIndicator={false}>
        {messages.map(m => (
          <View key={m._id} style={[styles.bubble, m.user === 'user' ? styles.userBubble : styles.botBubble]}>
            <Text style={styles.messageName}>{m.user === 'user' ? 'Макс' : 'Бот'}</Text>
            <Text style={m.user === 'user' ? styles.userText : styles.botText}>{m.text}</Text>
          </View>
        ))}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.chatInput}
          value={input}
          onChangeText={setInput}
          placeholder="Защищённое сообщение..."
          placeholderTextColor="#8ea1ff"
          onSubmitEditing={sendMessage}
        />
        <TouchableOpacity style={styles.sendBtn} onPress={sendMessage}>
          <Text style={{ color: '#141b37', fontSize: 20, fontWeight: 'bold' }}>➤</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ========== ЕЩЁ ==========
function MoreScreen() {
  const apps = [
    { name: 'Telegram', url: 'https://t.me', icon: '️' },
    { name: 'YouTube', url: 'https://youtube.com', icon: '▶️' },
    { name: 'Google', url: 'https://google.com', icon: '' },
    { name: 'Яндекс', url: 'https://yandex.ru', icon: 'Я' },
    { name: 'GitHub', url: 'https://github.com', icon: '' },
    { name: 'Stack Overflow', url: 'https://stackoverflow.com', icon: '📚' },
  ];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>⚙️ Ещё</Text>

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>🚀 Быстрый доступ</Text>
        <View style={styles.appsGrid}>
          {apps.map((a, i) => (
            <TouchableOpacity key={i} style={styles.appButton} onPress={() => WebBrowser.openBrowserAsync(a.url)}>
              <Text style={styles.appIcon}>{a.icon}</Text>
              <Text style={styles.appName}>{a.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>ℹ️ О приложении</Text>
        <Text style={styles.info}> Информатор v2.0</Text>
        <Text style={styles.info}>🔐 AES-256 шифрование</Text>
        <Text style={styles.info}>🛡️ PIN-защита</Text>
        <Text style={styles.info}>🌍 Геопозиция</Text>
        <Text style={styles.info}> Свежие новости</Text>
        <Text style={styles.info}>💰 Курсы валют и крипты</Text>
        <Text style={styles.info}>🎉 Праздники и история</Text>
      </View>

      <View style={styles.widget}>
        <Text style={styles.widgetTitle}>🛠️ Технологии</Text>
        <Text style={styles.info}>React Native + Expo</Text>
        <Text style={styles.info}>Локальная нейросеть: Qwen2.5-Coder</Text>
        <Text style={styles.info}>Создано с ❤️ на Linux Mint</Text>
      </View>
    </ScrollView>
  );
}

// ========== НАВИГАЦИЯ ==========
export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          tabBarStyle: styles.tabBar,
          tabBarActiveTintColor: '#ff9f7f',
          tabBarInactiveTintColor: '#8ea1ff',
          tabBarLabelStyle: styles.tabLabel,
          headerShown: false,
        }}
      >
        <Tab.Screen name="Главная" component={HomeScreen} options={{ tabBarIcon: () => <Text style={{ fontSize: 22 }}>🏠</Text> }} />
        <Tab.Screen name="Новости" component={NewsScreen} options={{ tabBarIcon: () => <Text style={{ fontSize: 22 }}>📰</Text> }} />
        <Tab.Screen name="Чат" component={ChatScreen} options={{ tabBarIcon: () => <Text style={{ fontSize: 22 }}>💬</Text> }} />
        <Tab.Screen name="Ещё" component={MoreScreen} options={{ tabBarIcon: () => <Text style={{ fontSize: 22 }}>⚙️</Text> }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

// ========== СТИЛИ ==========
const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: '#0e1226', flexGrow: 1 },
  title: { fontSize: 28, fontWeight: '900', color: '#ffffff', marginBottom: 5 },
  subtitle: { fontSize: 14, color: '#aeb8ff', marginBottom: 15 },
  locButton: { backgroundColor: '#ff9f7f', borderRadius: 14, paddingVertical: 12, alignItems: 'center', marginBottom: 15 },
  locButtonText: { color: '#141b37', fontWeight: '800', fontSize: 15 },
  widget: { backgroundColor: '#141c3b', borderRadius: 20, padding: 18, marginBottom: 15 },
  widgetTitle: { color: '#ff9f7f', fontSize: 17, fontWeight: '800', marginBottom: 12 },
  time: { fontSize: 46, fontWeight: '900', color: '#82d4ff', marginBottom: 5 },
  date: { fontSize: 14, color: '#d7e0ff', textTransform: 'capitalize' },
  temp: { fontSize: 42, fontWeight: '900', color: '#ffffff' },
  desc: { fontSize: 15, color: '#d7e0ff', marginTop: 5 },
  cityName: { fontSize: 12, color: '#ffcf9f', marginTop: 3, fontWeight: '700' },
  currencyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#1b2541' },
  currencyLabel: { fontSize: 15, color: '#e8eeff', fontWeight: '600' },
  currencyValue: { fontSize: 15, color: '#82d4ff', fontWeight: '700' },
  historyItem: { marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#1b2541' },
  historyYear: { fontSize: 13, color: '#ff9f7f', fontWeight: '700', marginBottom: 4 },
  historyText: { fontSize: 14, color: '#e8eeff', lineHeight: 20 },
  holidayItem: { backgroundColor: '#0f1833', borderRadius: 14, padding: 14, marginBottom: 10 },
  holidayName: { fontSize: 15, color: '#ffffff', fontWeight: '700', marginBottom: 5 },
  holidayDate: { fontSize: 13, color: '#82d4ff', marginBottom: 5 },
  holidayTip: { fontSize: 13, color: '#c7d1ff', lineHeight: 18 },
  searchInput: { backgroundColor: '#0f1833', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, color: '#e8eeff', fontSize: 14, marginBottom: 10 },
  searchButton: { backgroundColor: '#ff9f7f', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginBottom: 10 },
  searchButtonText: { color: '#141b37', fontWeight: '800' },
  optionsList: { marginTop: 10, borderRadius: 12, backgroundColor: '#0f1833', overflow: 'hidden' },
  optionItem: { paddingHorizontal: 14, paddingVertical: 10, borderBottomColor: '#1b2541', borderBottomWidth: 1 },
  optionText: { color: '#e8eeff', fontSize: 14, fontWeight: '600' },
  newsItem: { backgroundColor: '#0f1833', borderRadius: 14, padding: 12, marginBottom: 10 },
  newsTitle: { fontSize: 14, color: '#e8eeff', marginBottom: 5 },
  newsMeta: { fontSize: 11, color: '#8ea1ff' },
  emptyText: { color: '#b0bfff', fontSize: 14, textAlign: 'center', padding: 20 },
  tabBar: { backgroundColor: '#141c3b', borderTopColor: '#1b2541', borderTopWidth: 1, paddingBottom: 5, paddingTop: 8 },
  tabLabel: { fontSize: 11, fontWeight: '600' },
  appsGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  appButton: { width: '45%', backgroundColor: '#0f1833', borderRadius: 14, padding: 15, alignItems: 'center', marginBottom: 10 },
  appIcon: { fontSize: 28, marginBottom: 5 },
  appName: { color: '#e8eeff', fontSize: 12, fontWeight: '600' },
  info: { color: '#c7d1ff', fontSize: 14, marginBottom: 8 },
  
  // Чат
  lockContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0e1226', padding: 30 },
  lockIcon: { fontSize: 80, marginBottom: 20 },
  lockTitle: { fontSize: 24, fontWeight: '900', color: '#ffffff', marginBottom: 10 },
  lockSubtitle: { fontSize: 14, color: '#8ea1ff', marginBottom: 30 },
  pinInput: { backgroundColor: '#141c3b', borderRadius: 14, paddingHorizontal: 20, paddingVertical: 15, color: '#e8eeff', fontSize: 24, width: '80%', textAlign: 'center', letterSpacing: 15, marginBottom: 20 },
  unlockBtn: { backgroundColor: '#ff9f7f', borderRadius: 14, paddingVertical: 15, paddingHorizontal: 40 },
  unlockText: { color: '#141b37', fontWeight: '800', fontSize: 16 },
  lockHint: { color: '#8ea1ff', fontSize: 12, marginTop: 15 },
  chatHeader: { paddingTop: 50, paddingBottom: 10, paddingHorizontal: 20, backgroundColor: '#141c3b', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chatTitle: { fontSize: 20, fontWeight: '900', color: '#ffffff' },
  chatSwitcher: { flexDirection: 'row', backgroundColor: '#0f1833', marginHorizontal: 10, marginTop: 10, borderRadius: 12, padding: 4 },
  chatTab: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 10 },
  chatTabActive: { backgroundColor: '#ff9f7f' },
  chatTabText: { color: '#8ea1ff', fontSize: 12, fontWeight: '600' },
  chatTabTextActive: { color: '#141b37', fontWeight: '800' },
  chatList: { flex: 1, padding: 10 },
  bubble: { maxWidth: '80%', padding: 12, borderRadius: 14, marginBottom: 8 },
  userBubble: { backgroundColor: '#ff9f7f', alignSelf: 'flex-end' },
  botBubble: { backgroundColor: '#1d2a5e', alignSelf: 'flex-start' },
  messageName: { fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 4 },
  userText: { color: '#141b37', fontWeight: '600', fontSize: 14 },
  botText: { color: '#e8eeff', fontSize: 14 },
  inputRow: { flexDirection: 'row', padding: 10, backgroundColor: '#141c3b', alignItems: 'center' },
  chatInput: { flex: 1, backgroundColor: '#0f1833', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#e8eeff', fontSize: 14, marginRight: 10 },
  sendBtn: { backgroundColor: '#ff9f7f', borderRadius: 12, width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
});