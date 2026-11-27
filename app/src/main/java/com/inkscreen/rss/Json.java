package com.inkscreen.rss;

import org.json.JSONException;
import org.json.JSONObject;

final class Json {
    private Json() {}
    static JSONObject object(Object... pairs) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        } catch (JSONException e) { throw new IllegalArgumentException(e); }
        return result;
    }
    interface Sink {
        void success(String id, JSONObject result);
        void failure(String id, String code, String message);
        void event(String name, Object data);
    }
}
