package dev.codexlan.remote;

import org.json.*;
import java.util.*;

final class ChatCatalog {
    static List<JSONObject> rows(JSONObject state) throws Exception {
        LinkedHashMap<String,JSONObject> rows=new LinkedHashMap<>();
        Map<String,JSONObject> catalogGroups=new HashMap<>();
        for(String key:new String[]{"catalog","threads"}){
            JSONArray source=state.optJSONArray(key);if(source==null)continue;
            for(int i=0;i<source.length();i++){
                JSONObject next=source.getJSONObject(i);String id=next.getString("id");JSONObject row=rows.get(id);
                String groupId=next.optString("groupId","chats");
                if(key.equals("catalog")&&next.has("groupOrder"))catalogGroups.putIfAbsent(groupId,next);
                if(row==null){
                    row=new JSONObject(next.toString());
                    JSONObject group=catalogGroups.get(groupId);
                    // A live-only row can carry an older rank for a group still in the catalog.
                    if(key.equals("threads")&&group!=null){
                        for(String field:new String[]{"groupOrder","groupName","projectPinned"})row.put(field,group.opt(field));
                        row.remove("order");
                    }
                    rows.put(id,row);
                }else for(String field:new String[]{"name","ready","historyReady"})if(next.has(field))row.put(field,next.get(field));
            }
        }
        ArrayList<JSONObject> result=new ArrayList<>(rows.values());
        result.sort(Comparator.comparingInt((JSONObject row)->row.optInt("groupOrder",Integer.MAX_VALUE)).thenComparing(row->row.optString("groupId","chats")).thenComparingInt(row->row.optInt("order",Integer.MAX_VALUE)));
        return result;
    }
}
