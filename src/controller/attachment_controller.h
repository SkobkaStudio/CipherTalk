// =============================================================================
//  controller/attachment_controller.h — загрузка и отдача файлов (CONTROLLER)
// =============================================================================
//  Как в Telegram: файлы НЕ хранятся в SQLite. Бинарник кладётся в data/files/,
//  а в таблице attachments остаётся путь + метаданные.
//
//  E2EE для файлов: клиент шифрует содержимое файла AES-GCM ДО отправки, то есть
//  на диске сервера лежит шифротекст. Ключ передачи файла — тот же механизм,
//  что и у сообщений (AES-ключ заворачивается RSA-ключом получателя).
//
//  Маршруты:
//    POST /api/upload            multipart/form-data -> {attachment:{...}}
//    GET  /files/<storage_key>/<filename>            -> бинарные данные
// =============================================================================
#pragma once
#include <string>
#include <sys/stat.h>
#include "../utils/http_server.h"
#include "../model/chat_repository.h"

class AttachmentController {
public:
    AttachmentController(HttpServer& srv, Database& db, ChatRepository& chats)
        : srv_(srv), db_(db), chats_(chats)
    { mkdir("data",0755); mkdir("data/files",0755); registerRoutes(); }

private:
    HttpServer& srv_;
    Database& db_;
    ChatRepository& chats_;

    // ---------- разбор multipart/form-data ----------
    // Тело запроса выглядит так:
    //   ------WebKitFormBoundaryXXX\r\n
    //   Content-Disposition: form-data; name="chat_id"\r\n\r\n5\r\n
    //   ------WebKitFormBoundaryXXX\r\n
    //   Content-Disposition: form-data; name="file"; filename="cat.png"\r\n
    //   Content-Type: image/png\r\n\r\n<бинарь>\r\n
    //   ------WebKitFormBoundaryXXX--\r\n
    struct Part { std::string name, filename, contentType, data; };

    static std::vector<Part> parseMultipart(const std::string& body, const std::string& boundary) {
        std::vector<Part> parts;
        std::string delim = "--" + boundary;
        size_t pos = body.find(delim);
        if (pos == std::string::npos) return parts;
        pos += delim.size();
        while (true) {
            // пропускаем CRLF после границы и возможный закрывающий "--"
            if (body.compare(pos,2,"--")==0) break;
            size_t partStart = body.find("\r\n", pos);
            if (partStart==std::string::npos) break;
            partStart += 2;
            size_t headerEnd = body.find("\r\n\r\n", partStart);
            if (headerEnd==std::string::npos) break;
            std::string headers = body.substr(partStart, headerEnd-partStart);
            size_t dataStart = headerEnd+4;
            size_t next = body.find(delim, dataStart);
            if (next==std::string::npos) break;
            // данные заканчиваются за CRLF перед следующей границей
            std::string data = body.substr(dataStart, next-dataStart-2);

            Part p;
            // вытаскиваем name="..." и filename="..." из Content-Disposition
            auto extract=[&](const std::string& key)->std::string{
                size_t k=headers.find(key+"=\"");
                if(k==std::string::npos) return "";
                size_t s=k+key.size()+2, e=headers.find('"',s);
                return headers.substr(s,e-s);
            };
            p.name = extract("name");
            p.filename = extract("filename");
            size_t ct = headers.find("Content-Type:");
            if (ct!=std::string::npos){ size_t e=headers.find("\r\n",ct); p.contentType=headers.substr(ct+13,e-ct-13);}
            else p.contentType="application/octet-stream";
            p.data = std::move(data);
            parts.push_back(std::move(p));
            pos = next + delim.size();
        }
        return parts;
    }

    void registerRoutes() {
        // ---------------- ЗАГРУЗКА ФАЙЛА ----------------
        srv_.route("POST","/api/upload",[this](HttpRequest& rq){
            if(!rq.userId) return HttpResponse::error("Не авторизован",401);

            // boundary берём из заголовка Content-Type
            std::string ct = rq.headers["content-type"];
            size_t bp = ct.find("boundary=");
            if (bp==std::string::npos) return HttpResponse::error("Нет boundary",400);
            std::string boundary = ct.substr(bp+9);
            size_t sp = boundary.find(';'); if(sp!=std::string::npos) boundary=boundary.substr(0,sp);

            auto parts = parseMultipart(rq.body, boundary);
            long long chatId=0, replyTo=0; std::string encryptedMeta; // контейнер с iv/ct для подписи сообщения
            Part* file=nullptr;
            for (auto& p : parts) {
                if (p.name=="chat_id") chatId=atoll(p.data.c_str());
                else if (p.name=="reply_to") replyTo=atoll(p.data.c_str());
                else if (p.name=="meta") encryptedMeta=p.data;      // {"iv":..,"ct":..} — шифр имени/размера
                else if (p.name=="file") file=&p;
            }
            if (!file || file->filename.empty()) return HttpResponse::error("Файл не получен",400);
            if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Нет доступа к чату",403);
            if (!chats_.canPost(chatId,rq.userId)) return HttpResponse::error("В канале пишут только админы",403);
            if (file->data.size() > 64ull*1024*1024) return HttpResponse::error("Файл больше 64 МБ",400);

            // 1) Пишем бинарь на диск со случайным именем (случайность = защита от перебора имён)
            std::string storageKey = crypto::randomToken(16);
            std::string diskPath = "data/files/" + storageKey;
            FILE* f = fopen(diskPath.c_str(),"wb");
            if (!f) return HttpResponse::error("Ошибка записи файла",500);
            fwrite(file->data.data(),1,file->data.size(),f);
            fclose(f);

            // 2) Создаём «файловое» сообщение: content_type=image|file, content=контейнер meta
            std::string mime = file->contentType;
            std::string contentType = (mime.rfind("image/",0)==0) ? "image" : "file";
            long long msgId = createMessageInChat(db_,chatId,rq.userId,contentType,
                                                  encryptedMeta.empty()?"{}":encryptedMeta,replyTo);

            // 3) Записываем строку в attachments
            sqlite3_stmt* st=nullptr;
            sqlite3_prepare_v2(db_.raw(),
                "INSERT INTO attachments(message_id,uploader_id,filename,mime,size,storage_key,created_at)"
                " VALUES(?,?,?,?,?,?,?)",-1,&st,nullptr);
            sqlite3_bind_int64(st,1,msgId); sqlite3_bind_int64(st,2,rq.userId);
            sqlite3_bind_text(st,3,file->filename.c_str(),-1,SQLITE_TRANSIENT);
            sqlite3_bind_text(st,4,mime.c_str(),-1,SQLITE_TRANSIENT);
            sqlite3_bind_int64(st,5,(long long)file->data.size());
            sqlite3_bind_text(st,6,storageKey.c_str(),-1,SQLITE_TRANSIENT);
            sqlite3_bind_int64(st,7,(long long)time(nullptr));
            sqlite3_step(st); sqlite3_finalize(st);

            Json j=Json::object();
            j["message_id"]=msgId; j["storage_key"]=storageKey;
            j["url"]="/files/"+storageKey+"/"+file->filename;
            return HttpResponse::json(j,201);
        });

        // ---------------- ОТДАЧА ФАЙЛА ПО URL ----------------
        // Префиксный маршрут: любой GET /files/... уходит в serveFile().
        srv_.routePrefix("GET","/files/",[this](HttpRequest& rq){ return serveFile(rq); });
    }

public:
    // Обработчик отдачи файла: путь вида /files/<storage_key>/<filename>.
    // Доступ разрешён только участникам чата, к которому относится вложение.
    HttpResponse serveFile(HttpRequest& rq) {
        if(!rq.userId) return HttpResponse::error("Не авторизован",401);
        // rq.path = /files/<key>/<name>
        size_t p1 = rq.path.find('/', 6); // после "/files/"
        if (p1==std::string::npos) return HttpResponse::error("Плохой путь",400);
        std::string key = rq.path.substr(6,p1-6);
        if (key.empty() || key.find("..")!=std::string::npos) return HttpResponse::error("Плохой ключ",400);

        // Находим запись и проверяем доступ к чату
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db_.raw(),
            "SELECT a.filename,a.mime,a.message_id,m.chat_id FROM attachments a "
            "JOIN messages m ON m.id=a.message_id WHERE a.storage_key=?",-1,&st,nullptr);
        sqlite3_bind_text(st,1,key.c_str(),-1,SQLITE_TRANSIENT);
        std::string filename, mime; long long chatId=0;
        if (sqlite3_step(st)==SQLITE_ROW){
            auto t=[&](int i)->std::string{auto p=sqlite3_column_text(st,i);return p?(const char*)p:"";};
            filename=t(0); mime=t(1); chatId=sqlite3_column_int64(st,3);
        }
        sqlite3_finalize(st);
        if (chatId==0) return HttpResponse::error("Файл не найден",404);
        if (!chats_.isMember(chatId,rq.userId)) return HttpResponse::error("Нет доступа",403);

        // Читаем с диска и отдаём как есть (клиент сам расшифрует, если файл был E2EE)
        std::string diskPath="data/files/"+key;
        FILE* f=fopen(diskPath.c_str(),"rb");
        if(!f) return HttpResponse::error("Файл потерян",404);
        std::string data; char buf[65536]; size_t n;
        while((n=fread(buf,1,sizeof buf,f))>0) data.append(buf,n);
        fclose(f);

        HttpResponse res; res.status=200; res.body=std::move(data);
        res.contentType=mime.empty()?"application/octet-stream":mime;
        res.extraHeaders.push_back("Content-Disposition: inline; filename=\""+filename+"\"");
        return res;
    }

    // Вспомогательная вставка сообщения (когда нужен chat_id до создания MessageRepository)
    static long long createMessageInChat(Database& db, long long chatId, long long senderId,
                                         const std::string& type, const std::string& content,
                                         long long replyTo) {
        sqlite3_stmt* st=nullptr;
        sqlite3_prepare_v2(db.raw(),
            "INSERT INTO messages(chat_id,sender_id,content_type,content,reply_to,created_at,hash)"
            " VALUES(?,?,?,?,?,?,?)",-1,&st,nullptr);
        sqlite3_bind_int64(st,1,chatId); sqlite3_bind_int64(st,2,senderId);
        sqlite3_bind_text(st,3,type.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_bind_text(st,4,content.c_str(),-1,SQLITE_TRANSIENT);
        if(replyTo) sqlite3_bind_int64(st,5,replyTo); else sqlite3_bind_null(st,5);
        sqlite3_bind_int64(st,6,(long long)time(nullptr));
        std::string h=crypto::sha256Hex(content);
        sqlite3_bind_text(st,7,h.c_str(),-1,SQLITE_TRANSIENT);
        sqlite3_step(st); sqlite3_finalize(st);
        return db.lastInsertId();
    }
};
