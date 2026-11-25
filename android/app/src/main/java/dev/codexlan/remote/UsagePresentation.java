package dev.codexlan.remote;

import org.json.JSONObject;

final class UsagePresentation {
    static float remaining(JSONObject window) {
        Object value=window==null?null:window.opt("remainingPercent");
        if(!(value instanceof Number))return -1;
        double number=((Number)value).doubleValue();
        return Double.isFinite(number)&&number>=0&&number<=100?(float)number:-1;
    }
    static String period(JSONObject window,String fallback) {
        long minutes=window==null?0:window.optLong("windowDurationMins");
        if(minutes<=0)return fallback;
        if(minutes%1440==0)return(minutes/1440)+" 天";
        if(minutes%60==0)return(minutes/60)+" 小时";
        return minutes+" 分钟";
    }
    static String percent(JSONObject window) {
        float value=remaining(window);return value<0?"暂不可用":Math.round(value)+"% 剩余";
    }
    static String syncNotice(JSONObject state) {
        if(state!=null&&state.optBoolean("online"))return "";
        String phase=state==null?"":state.optString("syncPhase");
        switch(phase){
            case "sync-retry":return "已连接电脑 · 正在重试同步聊天";
            case "reconnecting":return "正在重新连接电脑";
            case "unreachable":return "暂未连上电脑 · 正在重试";
            case "authorization":return "电脑未接受设备授权";
            case "stopped":return "后台同步已停止";
            default:return "正在连接电脑并同步聊天";
        }
    }
    static String connection(JSONObject state,JSONObject thread,String message,boolean sending,String sendMode) {
        if(state==null)return "connecting";
        if(!state.optBoolean("online")&&state.has("syncPhase")){
            String phase=state.optString("syncPhase");
            if("authorization".equals(phase)||"unreachable".equals(phase))return "error";
            return "stopped".equals(phase)?"offline":"connecting";
        }
        if(!state.optBoolean("online"))return message!=null&&(message.contains("中断")||message.contains("失败")||message.contains("无法"))?"error":"offline";
        if("none".equals(MobileState.composerAction(state,thread,sending,"text",sendMode)))return "waiting";
        if((thread.optJSONArray("approvals")!=null&&thread.optJSONArray("approvals").length()>0)||(thread.optJSONArray("questions")!=null&&thread.optJSONArray("questions").length()>0))return "waiting";
        return MobileState.activeTurnId(thread).isEmpty()&&!"active".equals(thread.optString("runtimeStatus"))?"connected":"busy";
    }
}
